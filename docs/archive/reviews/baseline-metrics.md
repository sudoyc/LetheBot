# Baseline Metrics - Phase N.0

**记录时间**: 2026-06-28  
**目的**: 建立 Post-MVP 补齐工作的起点状态

---

## 测试状态

**测试框架**: Vitest  
**测试文件数**: 27 files  
**测试总数**: 291 tests  
**测试状态**: ✅ All passing

**测试覆盖**:
- Unit tests: Types, Storage, Context, Attention, Tools, Policy, Pi, Workers, CLI
- Integration tests: Memory injection
- Fakes: FakeOneBot adapter

---

## 类型检查

**工具**: TypeScript Compiler  
**命令**: `pnpm typecheck`  
**状态**: ✅ Pass (无类型错误)

---

## 代码质量

**工具**: ESLint  
**命令**: `pnpm lint`  
**状态**: ⚠️ 17 warnings (主要是未使用变量)

**问题汇总**:
- `src/cli/governance.ts`: 1 unused var
- `src/context/builder.ts`: 2 unused vars (memoryRepo, identityRepo)
- `src/gateway/adapter.ts`: 9 unused vars (接口参数)
- `src/gateway/onebot-adapter.ts`: 2 issues (unused var + any type)

**评估**: 非阻塞性，主要是 stub 方法的未使用参数，可在实现时修复

---

## 数据库状态

**数据库路径**: `data/lethebot.db`  
**Schema 版本**: v1 (initial_schema)

**表结构**: ✅ 完整 (22 张表)

核心表:
- canonical_users
- platform_accounts
- platform_groups
- display_profiles
- nickname_history
- raw_events
- chat_messages
- memory_records
- memory_sources
- memory_revisions
- memory_fts (全文搜索)
- agent_turns
- action_decisions
- action_executions
- tool_calls
- audit_log
- jobs
- schema_version

**数据状态**: ❌ 所有表为空

```sql
SELECT COUNT(*) FROM raw_events;      -- 0
SELECT COUNT(*) FROM chat_messages;   -- 0
SELECT COUNT(*) FROM memory_records;  -- 0
SELECT COUNT(*) FROM canonical_users; -- 0
```

**评估**: 符合预期，POST-MVP-GAP-ANALYSIS 已识别此问题

---

## 架构模块状态

### ✅ 已实现并工作
- Gateway Adapter (OneBot HTTP)
- Attention Engine (trigger + suppressor 逻辑)
- Tool Registry (注册和查询)
- Policy Gate (L0 权限检查)
- Pi Agent Runtime (DeepSeek 集成)
- Response Router (消息发送)
- Database Schema (表结构完整)
- Identity Repository (代码存在)
- Memory Repository (代码存在)

### ⚠️ 部分实现 (Stub)
- Context Builder (存在但未使用 memoryRepo/identityRepo)
- Background Workers (框架存在但不写数据)
- Memory Policy Gate (未实现 evaluator)

### ❌ 完全缺失
- Raw Event Store 写入
- Chat Messages 持久化
- Memory Extraction (不写 memory_records)
- Context History 注入 (只传当前消息)
- Persona System (硬编码 system prompt)
- Identity Resolution (未调用)
- Memory Retrieval (未从数据库读取)

---

## 功能验收现状

| 验收标准 | 状态 | 备注 |
|---------|------|------|
| 所有测试通过 | ✅ | 291 tests passing |
| 类型检查通过 | ✅ | tsc --noEmit clean |
| ESLint 无错误 | ⚠️ | 17 warnings (未使用变量) |
| 数据库表有数据 | ❌ | 所有核心表为 0 条记录 |
| Bot 能记住对话 | ❌ | 无历史消息注入 |
| 群聊回复简短 | ❌ | 硬编码 system prompt |
| 私聊回复自然 | ❌ | 无 persona 系统 |
| 后台工作器运行 | ❌ | 不写入数据 |

---

## Gap Analysis 确认

参考 `docs/POST-MVP-GAP-ANALYSIS.md`:

**P0 缺失** (阻塞性):
1. ❌ Raw Event Store 写入
2. ❌ Chat Messages 持久化
3. ❌ Context 历史注入
4. ❌ Persona 系统

**P1 缺失** (重要):
5. ❌ Memory Extraction
6. ❌ Identity Resolution

**MVP 完成度**: 65% 架构 / 35% 功能缺失

---

## 下一步

**Phase N.1: Data Persistence Layer**

预估时间: 1.5 小时

核心任务:
1. 实现 Raw Event Store 写入 (20 min)
2. 实现 Chat Messages 持久化 (20 min)
3. 实现 Bot Response 记录 (15 min)
4. 集成测试 (15 min)

**验收标准**:
- ✅ `SELECT COUNT(*) FROM raw_events` > 0
- ✅ `SELECT COUNT(*) FROM chat_messages` > 0
- ✅ Bot 消息也存入数据库
- ✅ 所有现有测试仍通过
- ✅ Git commit 完成

---

**Baseline 建立完成**  
**开始时间**: 2026-06-28  
**准备进入**: Phase N.1 (Data Persistence Layer)
