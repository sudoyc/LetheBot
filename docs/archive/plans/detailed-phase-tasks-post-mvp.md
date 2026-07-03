# Detailed Phase Tasks - Post-MVP to Production

本文档详细展开每个 Phase 的具体任务、文件、测试和验收标准。

---

## Phase N.0: Post-MVP Foundation (15 min)

**目标**: 建立 baseline，确认起点状态

**任务清单**:
1. 读取 `docs/POST-MVP-GAP-ANALYSIS.md`
2. 运行 `pnpm test` 确认测试状态
3. 运行 `pnpm typecheck` 确认类型
4. 检查数据库：`sqlite3 data/lethebot.db "SELECT COUNT(*) FROM raw_events"`
5. 记录 baseline metrics

**交付物**:
- baseline-metrics.md 记录当前状态

**验收标准**:
- ✅ 所有测试通过 (291 tests)
- ✅ 类型检查通过
- ✅ Baseline 记录完整

---

## Phase N.1: Data Persistence Layer (1.5 hr)

**目标**: 实现完整的数据持久化，让数据库不再为空

### Task N.1.1: Raw Event Store 写入 (20 min)

**文件**:
- `src/index.ts` (修改 handleEvent)

**实现**:
```typescript
private async storeRawEvent(event: ChatMessageReceived): Promise<void> {
  const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await this.db.run(`
    INSERT INTO raw_events (
      id, type, timestamp, source, platform,
      conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    eventId,
    event.type,
    new Date(event.timestamp).getTime(),
    'gateway',
    'qq',
    event.conversationId,
    JSON.stringify(event),
    Date.now(),
  ]);
}
```

**测试**:
- 单元测试：`tests/unit/storage/raw-events.test.ts`
- 集成测试：发送消息后查询数据库

**验收**:
- ✅ `SELECT COUNT(*) FROM raw_events` > 0
- ✅ 测试通过

### Task N.1.2: Chat Messages 持久化 (20 min)

**文件**:
- `src/index.ts` (修改 handleEvent)

**实现**:
```typescript
private async storeChatMessage(event: ChatMessageReceived): Promise<void> {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userId = event.message.senderId.replace('qq-', '');

  await this.db.run(`
    INSERT INTO chat_messages (
      id, platform_message_id, canonical_user_id,
      conversation_id, message_type, text,
      timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    messageId,
    event.message.messageId,
    userId,
    event.conversationId,
    event.message.conversationType,
    event.message.content.text || '',
    new Date(event.timestamp).getTime(),
    Date.now(),
  ]);
}
```

**测试**:
- 单元测试：`tests/unit/storage/chat-messages.test.ts`
- 集成测试：验证消息存储完整性

**验收**:
- ✅ `SELECT COUNT(*) FROM chat_messages` > 0
- ✅ 能查询到文本内容

### Task N.1.3: Bot Response 记录 (15 min)

**文件**:
- `src/index.ts` (handleEvent 中 Bot 回复后)

**实现**:
```typescript
// Bot 回复后，也记录到 chat_messages
await this.storeBotResponse({
  conversationId: event.conversationId,
  text: responseText,
  timestamp: Date.now(),
});
```

**验收**:
- ✅ Bot 消息也存入 chat_messages
- ✅ `isFromBot` 字段正确标记

### Task N.1.4: Integration Test (15 min)

**文件**:
- `tests/integration/data-persistence.test.ts` (新建)

**测试场景**:
1. 发送消息 → raw_events 有记录
2. 发送消息 → chat_messages 有记录
3. Bot 回复 → Bot 消息也有记录
4. 验证时间戳正确
5. 验证关联字段正确

**验收**:
- ✅ 所有持久化测试通过

**Phase N.1 总验收**:
- ✅ 3 个表有数据
- ✅ 新增测试通过
- ✅ 现有测试仍通过
- ✅ Git commit: `feat: implement data persistence layer`

---

## Phase N.2: Context & History (1 hr)

**目标**: Context Orchestrator 能读取历史消息并注入

### Task N.2.1: Load Recent Messages (30 min)

**文件**:
- `src/context/builder.ts` (修改 buildContext)

**实现**:
```typescript
private async loadRecentMessages(
  conversationId: string,
  limit: number = 20
): Promise<ContextMessage[]> {
  const rows = await this.db.all(`
    SELECT
      id, canonical_user_id, text, timestamp, created_at
    FROM chat_messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [conversationId, limit]);

  return rows.reverse().map((row: any) => ({
    messageId: row.id,
    senderId: `qq-${row.canonical_user_id}`,
    text: row.text,
    timestamp: new Date(row.timestamp),
    senderDisplayName: `qq-${row.canonical_user_id}`,
    isFromBot: false, // 后续改进
  }));
}
```

**测试**:
- `tests/unit/context/history-loading.test.ts`

**验收**:
- ✅ 能读取最近 N 条消息
- ✅ 按时间正序排列
- ✅ 测试覆盖边界情况（0 条、1 条、>limit 条）

### Task N.2.2: 注入到 ContextPack (20 min)

**文件**:
- `src/context/builder.ts` (buildContext 方法)

**实现**:
```typescript
async buildContext(input: ContextBuilderInput): Promise<ContextPack> {
  // 加载历史消息
  const recentMessages = await this.loadRecentMessages(
    input.conversationId,
    20
  );

  return {
    turnId: input.turnId,
    conversationContext: {
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      recentMessages, // 使用真实历史
      participantContext: {
        activeUserIds: input.targetUserId ? [input.targetUserId] : [],
        displayNames: new Map(),
        roles: new Map(),
      },
    },
    // ...
  };
}
```

**验收**:
- ✅ ContextPack 包含历史消息
- ✅ 不再只有当前消息

### Task N.2.3: End-to-End Memory Test (10 min)

**文件**:
- `tests/integration/e2e-memory.test.ts` (新建)

**测试场景**:
```typescript
test('Bot remembers conversation history', async () => {
  // 1. 发送 "我叫 Alice"
  await sendMessage('我叫 Alice');

  // 2. 等待 Bot 回复
  await waitForResponse();

  // 3. 发送 "我叫什么"
  await sendMessage('我叫什么');

  // 4. Bot 回复应包含 "Alice"
  const response = await waitForResponse();
  expect(response).toContain('Alice');
});
```

**验收**:
- ✅ Bot 能在下次对话中引用历史

**Phase N.2 总验收**:
- ✅ Context 包含历史消息
- ✅ E2E 测试通过
- ✅ Git commit: `feat: implement context history injection`

---

## Phase N.3: Persona System (45 min)

**目标**: 根据场景动态生成 system prompt，改善回复质量

### Task N.3.1: Persona Builder (25 min)

**文件**:
- `src/context/persona.ts` (新建)

**实现**:
```typescript
export interface PersonaContext {
  conversationType: 'private' | 'group';
  hasMemorySystem: boolean;
  platformRules?: string[];
}

export function buildSystemPrompt(context: PersonaContext): string {
  const base = `你是 LetheBot，一个有持久记忆的 QQ 机器人。

你的记忆能力：
- 你能记住之前的对话、用户偏好、重要事实
- 你能跨会话访问历史记忆
- 上下文中的"历史消息"是系统从长期存储中检索注入的

你的回复原则：
- 理解上下文，不重复已说过的话
- 如果不确定，可以说"我不太清楚"
- 不编造信息`;

  if (context.conversationType === 'group') {
    return `${base}

群聊风格：
- **简短自然**（1-2 句话，最多 30 字）
- 不说教、不过度礼貌、不客套
- 理解网络用语和群聊文化
- 不必每次都回复，沉默也是选择
- 不使用 emoji（😊 ✨ 等），除非用户先用
- 直接回答，不要"哈哈""嗯嗯"开头`;
  }

  return `${base}

私聊风格：
- 可以稍微详细，但保持简洁
- 友好、自然、不僵硬
- 可以追问澄清问题
- 理解用户意图`;
}
```

**测试**:
- `tests/unit/context/persona.test.ts`

**验收**:
- ✅ 群聊和私聊生成不同 prompt
- ✅ Prompt 包含记忆能力说明

### Task N.3.2: 集成到主循环 (15 min)

**文件**:
- `src/index.ts` (handleEvent 中调用 Pi 之前)

**实现**:
```typescript
import { buildSystemPrompt } from './context/persona.js';

// 替换硬编码
const systemPrompt = buildSystemPrompt({
  conversationType: event.message.conversationType,
  hasMemorySystem: true,
});

piResult = await this.pi.runTurn({
  contextPack: context,
  systemPrompt, // 动态生成
  // ...
});
```

**验收**:
- ✅ 不再硬编码
- ✅ 群聊回复 <30 字
- ✅ 私聊回复自然

### Task N.3.3: Response Quality Test (5 min)

**测试场景**:
1. 群聊 @bot → 回复简短
2. 私聊问问题 → 回复详细但不啰嗦
3. 不再有"😊""抱歉""请保持文明"

**验收**:
- ✅ 回复质量明显改善

**Phase N.3 总验收**:
- ✅ Persona 系统工作
- ✅ 回复风格符合预期
- ✅ Git commit: `feat: implement persona system`

---

## Phase N.4: Memory Extraction (2 hr)

**目标**: 从对话中提取记忆并存储

### Task N.4.1: 简化版提取器 (1 hr)

**文件**:
- `src/workers/memory-extraction.ts` (修改)

**实现**:
```typescript
export class MemoryExtractionWorker {
  async extractFromTurn(turn: {
    conversationId: string;
    userId: string;
    userMessage: string;
    botResponse: string;
  }): Promise<void> {
    // 简化策略：检测明确的自述句
    const patterns = [
      { regex: /我叫(.+)/, type: 'name' },
      { regex: /我是(.+)/, type: 'identity' },
      { regex: /我的(.+)是(.+)/, type: 'attribute' },
      { regex: /我喜欢(.+)/, type: 'preference' },
      { regex: /我不喜欢(.+)/, type: 'preference' },
    ];

    for (const { regex, type } of patterns) {
      const match = turn.userMessage.match(regex);
      if (match) {
        await this.createMemory({
          scope: 'user',
          ownerId: turn.userId,
          visibility: 'private_only',
          sensitivity: 'personal',
          content: turn.userMessage,
          extractedFact: match[1],
          type,
        });
      }
    }
  }

  private async createMemory(data: any): Promise<void> {
    const memoryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await this.memoryRepo.create({
      id: memoryId,
      state: 'active', // 简化：直接 active
      scope: data.scope,
      owner_id: data.ownerId,
      visibility: data.visibility,
      sensitivity: data.sensitivity,
      content: data.content,
      confidence: 0.9,
      source_type: 'chat',
      source_id: data.conversationId,
      created_at: Date.now(),
    });
  }
}
```

**测试**:
- `tests/unit/workers/memory-extraction.test.ts`

**验收**:
- ✅ 能识别基本模式
- ✅ 记忆存入 memory_records

### Task N.4.2: 集成到主循环 (30 min)

**文件**:
- `src/index.ts` (handleEvent 中 Bot 回复后)

**实现**:
```typescript
// Bot 回复后
if (responseText.trim().length > 0) {
  // ... 发送回复

  // 提取记忆
  await this.memoryExtractor.extractFromTurn({
    conversationId: event.conversationId,
    userId: canonicalUserId,
    userMessage: event.message.content.text || '',
    botResponse: responseText,
  });
}
```

**验收**:
- ✅ 每次对话后尝试提取
- ✅ 不阻塞回复

### Task N.4.3: Memory Test (30 min)

**文件**:
- `tests/integration/memory-extraction.test.ts`

**测试场景**:
```typescript
test('Extract user preferences', async () => {
  await sendMessage('我喜欢看科幻电影');
  await waitForResponse();

  const memories = await db.all(`
    SELECT * FROM memory_records
    WHERE content LIKE '%科幻电影%'
  `);

  expect(memories.length).toBeGreaterThan(0);
  expect(memories[0].scope).toBe('user');
});
```

**验收**:
- ✅ 记忆提取测试通过

**Phase N.4 总验收**:
- ✅ Memory records 表有数据
- ✅ 基本模式识别工作
- ✅ Git commit: `feat: implement memory extraction`

---

## Phase N.5: Identity Resolution (45 min)

**目标**: 使用 canonical_user_id 替代原始 QQ ID

### Task N.5.1: Identity Resolver (30 min)

**文件**:
- `src/index.ts` (handleEvent 开始处)

**实现**:
```typescript
private async resolveIdentity(platformUserId: string): Promise<string> {
  // 1. 查找现有映射
  const existing = await this.identityRepo.findByPlatformAccount(
    'qq',
    platformUserId
  );

  if (existing) {
    return existing.canonicalUserId;
  }

  // 2. 创建新用户
  const canonicalUserId = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await this.identityRepo.createUser({
    canonicalUserId,
    actorClass: 'user',
    trustLevel: 'normal',
  });

  await this.identityRepo.linkPlatformAccount({
    canonicalUserId,
    platform: 'qq',
    platformUserId,
  });

  return canonicalUserId;
}
```

**验收**:
- ✅ 能创建新用户
- ✅ 能查找现有用户

### Task N.5.2: 更新所有调用点 (15 min)

**文件**:
- `src/index.ts` (handleEvent)
- 所有使用 senderId 的地方

**修改**:
```typescript
// 在 handleEvent 开头
const senderId = event.message.senderId.replace('qq-', '');
const canonicalUserId = await this.resolveIdentity(senderId);

// 后续使用 canonicalUserId
await this.storeChatMessage({ ..., canonicalUserId });
await this.buildContext({ ..., targetUserId: canonicalUserId });
```

**验收**:
- ✅ canonical_users 表有数据
- ✅ platform_accounts 表有映射

**Phase N.5 总验收**:
- ✅ Identity 系统工作
- ✅ 数据表正确关联
- ✅ Git commit: `feat: implement identity resolution`

---

## Phase N.6: Memory Retrieval (1.5 hr)

**目标**: Context Orchestrator 能检索相关记忆并注入

### Task N.6.1: Memory Query Builder (45 min)

**文件**:
- `src/context/builder.ts`

**实现**:
```typescript
private async retrieveRelevantMemories(
  input: ContextBuilderInput
): Promise<MemoryRecord[]> {
  // 简化：查询用户的所有可见记忆
  const memories = await this.memoryRepo.search({
    scope: 'user',
    ownerId: input.targetUserId,
    visibility: [
      'private_only',
      input.conversationType === 'group' ? 'same_group_only' : 'any_conversation'
    ],
    state: 'active',
    limit: 10,
  });

  return memories;
}
```

**验收**:
- ✅ 能检索用户记忆
- ✅ 遵守 visibility 规则

### Task N.6.2: 注入到 ContextPack (30 min)

**文件**:
- `src/context/builder.ts` (buildContext)

**实现**:
```typescript
async buildContext(input: ContextBuilderInput): Promise<ContextPack> {
  const recentMessages = await this.loadRecentMessages(...);
  const relevantMemories = await this.retrieveRelevantMemories(input);

  return {
    // ...
    memoryContext: {
      visibleMemories: relevantMemories.map(m => ({
        memoryId: m.id,
        content: m.content,
        confidence: m.confidence,
        createdAt: new Date(m.created_at),
      })),
      selectedMemoryIds: relevantMemories.map(m => m.id),
    },
  };
}
```

**验收**:
- ✅ ContextPack 包含记忆
- ✅ 记忆符合可见性规则

### Task N.6.3: E2E Memory Retrieval Test (15 min)

**测试场景**:
```typescript
test('Bot uses retrieved memories', async () => {
  // 1. 私聊告诉 Bot："我喜欢红色"
  await sendPrivateMessage('我喜欢红色');

  // 2. 等待，确保记忆存储
  await sleep(1000);

  // 3. 问："我喜欢什么颜色？"
  await sendPrivateMessage('我喜欢什么颜色');

  // 4. Bot 应该回答包含"红色"
  const response = await waitForResponse();
  expect(response).toContain('红色');
});
```

**验收**:
- ✅ Bot 能检索并使用记忆

**Phase N.6 总验收**:
- ✅ 记忆检索工作
- ✅ E2E 测试通过
- ✅ Git commit: `feat: implement memory retrieval`

---

## Phase N.7: Background Workers (1 hr)

**目标**: 后台工作器自动执行，而不是手动触发

### Task N.7.1: Worker Scheduler (40 min)

**文件**:
- `src/workers/scheduler.ts` (新建)

**实现**:
```typescript
export class WorkerScheduler {
  private intervals: NodeJS.Timeout[] = [];

  start(): void {
    // Memory extraction worker (每 60 秒)
    const extractionInterval = setInterval(async () => {
      await this.runMemoryExtraction();
    }, 60_000);

    this.intervals.push(extractionInterval);

    // Summary worker (每 5 分钟)
    const summaryInterval = setInterval(async () => {
      await this.runSummaryWorker();
    }, 300_000);

    this.intervals.push(summaryInterval);
  }

  stop(): void {
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
  }

  private async runMemoryExtraction(): Promise<void> {
    // 查找最近 1 分钟的对话，提取记忆
    // ...
  }

  private async runSummaryWorker(): Promise<void> {
    // 总结最近活动
    // ...
  }
}
```

**验收**:
- ✅ Worker 能定期执行

### Task N.7.2: 集成到主应用 (20 min)

**文件**:
- `src/index.ts` (start/stop 方法)

**实现**:
```typescript
async start(): Promise<void> {
  // ...现有启动逻辑

  // 启动后台工作器
  this.workerScheduler.start();

  logger.info('Background workers started');
}

async stop(): Promise<void> {
  this.workerScheduler.stop();
  // ...现有停止逻辑
}
```

**验收**:
- ✅ Worker 随应用启动/停止

**Phase N.7 总验收**:
- ✅ 后台工作器自动运行
- ✅ Git commit: `feat: implement background worker scheduler`

---

## Phase N.8-N.11: 后续阶段

(由于篇幅，这里仅列出概要，详细内容会在执行时展开)

### Phase N.8: Tool Implementation (2 hr)
- 实现真实工具（搜索、发送、管理）
- 工具权限检查
- 工具审计日志

### Phase N.9: Evaluator & Policy (2 hr)
- 实现 LLM Evaluator
- 记忆提案审查
- 工具调用审查

### Phase N.10: Response Optimization (1 hr)
- 回复长度控制
- 回复质量监控
- Cooldown 机制

### Phase N.11: Production Readiness (2 hr)
- 完整 E2E 测试套件
- 性能测试
- 部署文档
- 监控指标

---

**总预估时长**: 12-15 小时

**验收原则**: 每个 Phase 必须通过测试才能进入下一个
