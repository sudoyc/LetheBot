# Post-MVP Gap Analysis

**日期**: 2026-06-27
**当前状态**: MVP 完成，基础功能可运行，但存在关键缺失
**目标**: 识别架构设计 vs 实际实现的差距，为下一阶段开发提供清单

---

## 执行摘要

**MVP 完成度**: 65% 架构实现 / 35% 功能缺失
**核心问题**: 数据持久化层完全缺失，导致"厚记忆层"设计无法运作
**影响**: Bot 能收发消息但无记忆、无历史、无个性

---

## 1. 架构设计 vs 实际实现对比表

| 模块 | 设计状态 | 实现状态 | 差距 | 优先级 |
|------|---------|---------|------|--------|
| **Gateway Adapter** | ✅ 完整 | ✅ 实现 | OneBot HTTP 已连接 | - |
| **Ingestion / Event Bus** | ✅ 设计 | ❌ 无实现 | 事件标准化缺失 | P0 |
| **Raw Event Store** | ✅ Schema | ❌ 无写入 | 数据库表空 | P0 |
| **Identity Registry** | ✅ Schema | ⚠️ 部分 | Repository 存在但未使用 | P1 |
| **Attention Engine** | ✅ 完整 | ✅ 实现 | 工作正常 | - |
| **Memory Candidates** | ✅ 设计 | ❌ 无实现 | 后台工作器不写数据 | P1 |
| **Memory Policy Gate** | ✅ 设计 | ⚠️ Stub | 评估器未实现 | P2 |
| **Thick Memory Layer** | ✅ Schema | ❌ 表为空 | 无记忆提取/存储 | P0 |
| **Context Orchestrator** | ✅ 接口 | ⚠️ 最小实现 | 只传当前消息，无历史 | P0 |
| **Pi Agent Runtime** | ✅ 接口 | ✅ 已集成 | DeepSeek 工作正常 | - |
| **Tool Registry** | ✅ 完整 | ✅ 实现 | 工作正常 | - |
| **Policy Gate** | ✅ 设计 | ✅ L0 实现 | 工作正常 | - |
| **Background Workers** | ✅ 设计 | ⚠️ Stub | 有框架但不写数据 | P1 |
| **Governance CLI** | ✅ 设计 | ✅ 实现 | CLI 存在但无数据可查 | - |
| **Response Router** | ✅ 设计 | ✅ 实现 | 工作正常 | - |

**图例**:
- ✅ 完整实现
- ⚠️ 部分实现或 Stub
- ❌ 完全缺失

---

## 2. 关键缺失功能详解

### P0 - 阻塞性缺失（必须实现才能正常工作）

#### 2.1 Raw Event Store 写入
**设计意图**: 每个事件都应该写入 raw_events 表作为审计基础

**当前状态**:
- 表结构存在 ✅
- **写入逻辑完全缺失** ❌
- `SELECT COUNT(*) FROM raw_events` = 0

**影响**:
- 无审计记录
- 后台工作器无法读取历史事件
- 无法回溯问题

---

#### 2.2 Chat Messages 持久化
**设计意图**: 所有聊天消息应该存入 chat_messages

**当前状态**:
- 表结构存在 ✅
- **写入逻辑完全缺失** ❌
- `SELECT COUNT(*) FROM chat_messages` = 0

**影响**:
- Context Orchestrator 无法读取历史消息
- 只传当前消息给 Pi，**没有上下文**
- Bot 不知道之前说过什么
- 无法实现"接续对话"

---

#### 2.3 Context Orchestrator 历史注入
**设计意图**: ContextPack 应包含 recent messages + visible memory

**当前状态**:
```typescript
// src/index.ts line 237
recentMessages: [
  {
    // 只有当前这一条消息！
    messageId: event.message.messageId,
    text: event.message.content.text ?? '',
  },
],
```

**影响**:
- Pi 看不到历史对话
- 每次回复都像"失忆"
- 无法理解上下文引用

---

#### 2.4 System Prompt / Persona 系统
**设计意图**: Context Orchestrator 应根据场景注入不同 persona

**当前状态**:
```typescript
// src/index.ts line 275
systemPrompt: 'You are LetheBot, a helpful assistant.'
// 硬编码在调用点！
```

**影响**:
- Bot 回复过于正式、说教
- 不理解群聊文化
- 回复太长
- 没有个性
- 不知道自己有记忆能力

---

### P1 - 重要缺失（影响核心功能）

#### 2.5 Memory Records 提取与存储
**设计意图**: Background Workers 应从对话中提取记忆并存储

**当前状态**:
- 表结构存在 ✅
- Background workers 有框架 ⚠️
- **完全不写 memory_records** ❌
- `SELECT COUNT(*) FROM memory_records` = 0

**影响**:
- "厚记忆层"设计完全无效
- Bot 不学习用户偏好
- 每次对话都重新开始

---

#### 2.6 Identity Resolution
**设计意图**: 通过 canonical_user_id 跨平台识别用户

**当前状态**:
- IdentityRepository 存在 ✅
- **从未被调用** ❌
- 直接用 `qq-123456` 作为 user ID

**影响**:
- 无法跨平台识别用户
- 同一个人在不同群的发言无法关联

---

## 3. 功能依赖树

```
🔴 P0: Raw Event Store 写入
  └─> 🔴 P0: Chat Messages 持久化
      └─> 🔴 P0: Context 历史注入
          └─> 🟡 P1: Memory 提取
              └─> 🟢 P2: Evaluator 审查

🔴 P0: Persona 系统
  (独立，不依赖其他)

🟡 P1: Identity Resolution
  └─> 🟡 P1: Memory scope 关联
```

**实现顺序建议**:
1. Raw Event Store 写入（15 分钟）
2. Chat Messages 持久化（20 分钟）
3. Persona 系统（30 分钟）
4. Context 历史注入（25 分钟）
5. Identity Resolution（30 分钟）
6. Memory 提取（2 小时）

**总预估**: 4-6 小时

---

## 4. 测试状态

**当前**: 27 test files, 291 tests passing ✅

**缺失测试场景**:
1. 完整对话流程（收消息 → 存储 → 检索 → 回复）
2. 跨会话记忆测试
3. Context 历史注入验证
4. Persona 不同场景表现

---

## 5. 下一阶段目标

### Phase N: Post-MVP Completion

**目标**: 补齐 P0 缺失，让 Bot 有记忆和个性

**验收标准**:
- 发送 "我叫 Alice"，Bot 回复
- 5 分钟后再问 "我叫什么"，Bot 能回答 "Alice"
- 群聊中回复简短自然（<30 字）
- 私聊中可以详细
- 数据库表不再为空

---

**Gap Analysis Complete**
**Next Action**: 生成 `/goal` prompt 补齐 Post-MVP 缺失
