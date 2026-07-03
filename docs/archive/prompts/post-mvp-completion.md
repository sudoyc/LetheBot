# Post-MVP Completion Goal

**目标**: 补齐 LetheBot MVP 的 P0 缺失功能，实现完整的记忆和上下文能力

---

## `/goal` Prompt

```
你是 LetheBot 项目的开发 agent，负责补齐 MVP 阶段遗留的核心功能缺失。

## 项目状态

**已完成**:
- ✅ 架构设计完整（32 个文档）
- ✅ 基础设施就绪（TypeScript + pnpm + Vitest）
- ✅ 核心模块实现（Gateway, Attention, Pi, Tools, Policy）
- ✅ 291 个测试通过
- ✅ 实时运行中（连接 NapCat，能收发消息）

**核心问题**:
- ❌ **数据持久化层完全缺失**
- ❌ 数据库表全部为空（raw_events, chat_messages, memory_records）
- ❌ Context Orchestrator 只传当前消息，无历史
- ❌ System Prompt 硬编码，Bot 回复质量差

**影响**: Bot 能对话但像"失忆客服"，每次都重新开始，无个性，回复过于正式。

## 你的任务

按顺序实现以下 P0 功能，**每个功能必须有测试验证**：

### 1. Raw Event Store 写入 (15 min)

**位置**: `src/index.ts` - `handleEvent()` 方法开始处

**要求**:
```typescript
// 在处理事件之前，先存储原始事件
private async storeRawEvent(event: ChatMessageReceived): Promise<void> {
  await this.db.run(`
    INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event.type,
    new Date(event.timestamp).getTime(),
    'gateway',
    'qq',
    event.conversationId,
    JSON.stringify(event),
    Date.now(),
  ]);
}

// 在 handleEvent() 开头调用
await this.storeRawEvent(event);
```

**测试**: 发送消息后，`SELECT COUNT(*) FROM raw_events` > 0

---

### 2. Chat Messages 持久化 (20 min)

**位置**: `src/index.ts` - `handleEvent()` 中，Attention 分析之后

**要求**:
```typescript
// 存储聊天消息（用于历史上下文）
private async storeChatMessage(event: ChatMessageReceived): Promise<void> {
  const userId = event.message.senderId.replace('qq-', '');

  await this.db.run(`
    INSERT INTO chat_messages (
      id, platform_message_id, canonical_user_id,
      conversation_id, message_type, text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event.message.messageId,
    userId, // 暂时用 QQ ID，Phase 5 会改用 canonical
    event.conversationId,
    event.message.conversationType,
    event.message.content.text || '',
    new Date(event.timestamp).getTime(),
  ]);
}

// 在 Attention 分析后、构建 Context 前调用
await this.storeChatMessage(event);
```

**测试**: 发送消息后，`SELECT COUNT(*) FROM chat_messages` > 0

---

### 3. Persona 系统 (30 min)

**新文件**: `src/context/persona.ts`

**要求**:
```typescript
export interface PersonaContext {
  conversationType: 'private' | 'group';
  hasMemorySystem: boolean;
}

export function buildSystemPrompt(context: PersonaContext): string {
  const base = `你是 LetheBot，一个有持久记忆的 QQ 机器人。

你的记忆能力：
- 你能记住之前的对话、用户偏好、重要事实
- 你能跨会话访问历史记忆
- 上下文中的"历史消息"和"记忆片段"是系统从你的长期记忆中检索注入的`;

  if (context.conversationType === 'group') {
    return `${base}

群聊风格：
- 简短自然（1-2 句话，最多 30 字）
- 不说教、不过度礼貌
- 理解网络用语和群聊文化
- 不必每次都回复，沉默也是选择
- 不要用 emoji 表情（😊 ✨ 等），除非用户先用
- 直接回答，不要"哈哈""嗯嗯"等语气词开头`;
  }

  return `${base}

私聊风格：
- 可以稍微详细，但保持简洁
- 友好、自然、不僵硬
- 可以追问澄清问题
- 理解用户意图，提供有用信息`;
}
```

**修改**: `src/index.ts` - 删除硬编码的 systemPrompt，改用 persona 系统：

```typescript
import { buildSystemPrompt } from './context/persona.js';

// 在调用 Pi 之前
const systemPrompt = buildSystemPrompt({
  conversationType: event.message.conversationType,
  hasMemorySystem: true,
});

piResult = await this.pi.runTurn({
  contextPack: context,
  systemPrompt,  // 使用动态生成的
  // ...
});
```

**测试**:
- 群聊消息：回复应 <30 字
- 私聊消息：回复可稍长
- 不再有"😊""抱歉""请保持文明"等客服腔

---

### 4. Context 历史消息注入 (25 min)

**位置**: `src/context/builder.ts` - `buildContext()` 方法

**要求**:
```typescript
// 在 buildContext() 中，替换 recentMessages 的硬编码单条消息

// 新增方法
private async loadRecentMessages(
  conversationId: string,
  limit: number = 20
): Promise<Array<{
  messageId: string;
  senderId: string;
  text: string;
  timestamp: Date;
  senderDisplayName: string;
  isFromBot: boolean;
}>> {
  const rows = await this.db.all(`
    SELECT
      id, canonical_user_id, text, created_at
    FROM chat_messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [conversationId, limit]);

  return rows.reverse().map((row: any) => ({
    messageId: row.id,
    senderId: `qq-${row.canonical_user_id}`,
    text: row.text,
    timestamp: new Date(row.created_at),
    senderDisplayName: `qq-${row.canonical_user_id}`, // Phase 5 改用 display name
    isFromBot: false, // 暂时简化，后续根据 sender 判断
  }));
}

// 在 buildContext() 中替换
const recentMessages = await this.loadRecentMessages(
  input.conversationId,
  20  // 最近 20 条
);

return {
  turnId: input.turnId,
  conversationContext: {
    conversationId: input.conversationId,
    conversationType: input.conversationType,
    recentMessages,  // 使用从数据库加载的历史
    // ...
  },
  // ...
};
```

**测试**:
- 发送 "我叫 Alice"
- 等待 Bot 回复
- 发送 "我叫什么"
- Bot 应该回答包含 "Alice" 的内容

---

### 5. Identity Resolution (30 min)

**位置**: `src/index.ts` - `handleEvent()` 开始处

**要求**:
```typescript
// 在 handleEvent() 开头，Raw Event 存储之后
private async resolveIdentity(platformUserId: string): Promise<string> {
  // 1. 查找现有映射
  const existing = await this.identityRepo.findByPlatformAccount('qq', platformUserId);
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

// 在 handleEvent() 中使用
const senderId = event.message.senderId.replace('qq-', '');
const canonicalUserId = await this.resolveIdentity(senderId);

// 后续使用 canonicalUserId 而不是原始 senderId
```

**修改**:
- `storeChatMessage()` 使用 `canonicalUserId`
- `buildContext()` 传入 `canonicalUserId`

**测试**:
- 发送消息后，`SELECT COUNT(*) FROM canonical_users` > 0
- `SELECT COUNT(*) FROM platform_accounts` > 0

---

### 6. Memory 提取（简化版）(1-2 hr)

**位置**: `src/workers/memory-extraction.ts`

**要求**: 实现基础的记忆提取逻辑

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
      /我叫(.+)/,
      /我是(.+)/,
      /我的(.+)是(.+)/,
      /我喜欢(.+)/,
      /我不喜欢(.+)/,
    ];

    for (const pattern of patterns) {
      const match = turn.userMessage.match(pattern);
      if (match) {
        await this.memoryRepo.createMemory({
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          state: 'active', // 简化：直接 active，不走 proposal
          scope: 'user',
          owner_id: turn.userId,
          visibility: 'private_only',
          sensitivity: 'personal',
          content: turn.userMessage,
          confidence: 0.9,
          source_type: 'chat',
          source_id: turn.conversationId,
          created_at: Date.now(),
        });
      }
    }
  }
}
```

**集成**: 在 `handleEvent()` Bot 回复后调用

**测试**: 发送 "我叫 Bob" 后，`SELECT COUNT(*) FROM memory_records` > 0

---

## 约束条件（必须遵守）

### 代码规范
1. **读取 AGENTS.md** - 遵守所有架构规则
2. **不破坏现有测试** - 291 个测试必须继续通过
3. **每个功能写测试** - 新增功能必须有单元测试或集成测试
4. **TypeScript 严格模式** - 不使用 `any`，正确类型标注
5. **不修改 schema** - 数据库结构已经正确，只需写入数据

### 实现顺序
- **必须按 1→2→3→4→5→6 顺序实现**
- 前面的功能是后面的基础
- 每完成一个功能，运行测试确认

### 测试验证
每个功能完成后，必须：
1. 运行 `pnpm test` 确保所有测试通过
2. 运行 `pnpm typecheck` 确保类型正确
3. 启动 `pnpm start` 手动测试实际效果
4. 检查数据库：`sqlite3 data/lethebot.db "SELECT COUNT(*) FROM <表名>"`

### Git 提交
- 每个功能单独提交
- Commit message 格式：`feat: implement <功能名>`
- 例如：`feat: implement raw event store persistence`

---

## 完成标准

**功能验证**:
1. ✅ Raw events 表有数据
2. ✅ Chat messages 表有数据
3. ✅ Memory records 表有数据（简单记忆）
4. ✅ Bot 能记住用户告诉它的信息
5. ✅ 群聊回复简短（<30 字）
6. ✅ 私聊回复自然友好
7. ✅ 所有测试通过

**端到端测试场景**:
```bash
# 场景 1: 记忆测试
1. 在私聊发送："我叫测试用户"
2. Bot 回复确认
3. 等待 10 秒
4. 发送："我叫什么？"
5. Bot 应该回答包含"测试用户"

# 场景 2: 风格测试
1. 在群聊发送："@bot 你好"
2. Bot 回复应该 <30 字，不带 emoji
3. 在私聊发送："你好"
4. Bot 回复可以稍长，风格自然
```

---

## 文档位置

**必读**:
- `AGENTS.md` - 项目规则
- `docs/POST-MVP-GAP-ANALYSIS.md` - 问题分析
- `docs/contracts.md` - 接口定义
- `docs/sqlite-schema.md` - 数据库结构

**参考**:
- `docs/architecture-flow-overview.md` - 架构流程
- `docs/context-orchestration.md` - Context 设计
- `docs/memory-system.md` - 记忆系统
- `docs/pi-integration.md` - Persona 位置

---

## 预期时长

- Phase 1-5: 2-3 小时
- Phase 6: 1-2 小时
- 测试验证: 30 分钟
- **总计**: 4-6 小时

---

## 开始执行

现在开始实现 Phase 1: Raw Event Store 写入。

读取 `src/index.ts`，在 `handleEvent()` 方法开始处添加 `storeRawEvent()` 调用。
```
