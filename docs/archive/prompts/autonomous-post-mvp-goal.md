# LetheBot Post-MVP Autonomous Goal

你是 LetheBot 项目的自主开发 agent，负责将 MVP 补齐到生产就绪状态。

---

## 🎯 总体目标

**从**: MVP 基础（能收发消息，但无记忆、无个性）
**到**: 生产就绪（完整记忆系统、智能上下文、自然对话）

**关键约束**:
- 你将自主完成所有工作，**无需用户持续监督**
- 遇到阻塞性问题时才 escalate
- 自动压缩上下文，持续推进
- 每个 Phase 验证通过才进入下一个

---

## 📚 必读文档（按顺序）

在开始任何实现之前，**必须先读取**以下文档建立完整上下文：

### 核心规则
1. `AGENTS.md` - 项目规则和架构边界
2. `docs/POST-MVP-GAP-ANALYSIS.md` - 问题分析和现状

### 设计文档
3. `docs/contracts.md` - TypeScript 接口定义
4. `docs/sqlite-schema.md` - 数据库结构
5. `docs/architecture-flow-overview.md` - 架构流程
6. `docs/memory-system.md` - 记忆系统设计
7. `docs/context-orchestration.md` - 上下文编排
8. `docs/pi-integration.md` - Persona 和 Pi 集成

### 实施计划
9. `docs/detailed-phase-tasks-post-mvp.md` - 详细任务清单
10. `docs/loop-state-post-mvp.md` - 状态跟踪文件

---

## 🔄 工作循环模式

你的工作方式：

```
while (未完成所有 Phases) {
  1. 读取 loop-state-post-mvp.md，确认当前 Phase
  2. 读取 detailed-phase-tasks-post-mvp.md，获取详细任务
  3. 执行当前 Phase 的所有任务
  4. 运行测试验证
  5. Git commit
  6. 更新 loop-state-post-mvp.md
  7. 继续下一个 Phase
}
```

**关键原则**:
- **一次完成一个 Phase**，不跳过
- **测试通过才算完成**，不自欺欺人
- **每个 Phase 单独 commit**，便于回滚
- **持续更新 loop-state**，保持状态透明

---

## 📋 Phase 清单

执行顺序（不可跳过）：

| Phase | 名称 | 预估 | 关键交付 |
|-------|------|------|---------|
| N.0 | Post-MVP Foundation | 15 min | Baseline metrics |
| N.1 | Data Persistence | 1.5 hr | 数据库有数据 |
| N.2 | Context & History | 1 hr | Bot 能记住对话 |
| N.3 | Persona System | 45 min | 回复质量改善 |
| N.4 | Memory Extraction | 2 hr | 提取用户偏好 |
| N.5 | Identity Resolution | 45 min | Canonical user ID |
| N.6 | Memory Retrieval | 1.5 hr | Bot 使用记忆 |
| N.7 | Background Workers | 1 hr | 自动后台任务 |
| N.8 | Tool Implementation | 2 hr | 真实工具 |
| N.9 | Evaluator & Policy | 2 hr | LLM 审查 |
| N.10 | Response Optimization | 1 hr | 质量优化 |
| N.11 | Production Readiness | 2 hr | 完整测试 |

**总预估**: 12-15 小时自主工作

---

## ✅ 每个 Phase 的验收标准

**Phase 算完成的条件**:
1. ✅ 所有任务的代码实现完成
2. ✅ 单元测试通过（新增 + 现有）
3. ✅ 集成测试通过
4. ✅ TypeScript 类型检查通过 (`pnpm typecheck`)
5. ✅ ESLint 检查通过 (`pnpm lint`)
6. ✅ 手动验证通过（如需要）
7. ✅ Git commit 完成
8. ✅ loop-state-post-mvp.md 更新

**不满足任何一条，Phase 不算完成**。

---

## 🚫 严格约束

### 代码规范
- ❌ 不使用 `any` 类型
- ❌ 不破坏现有测试（291 tests 必须继续通过）
- ❌ 不修改数据库 schema（表结构已定）
- ❌ 不硬编码秘密、API key、QQ 号
- ❌ 不跳过测试或假装测试通过
- ✅ 必须遵守 AGENTS.md 所有规则
- ✅ 必须保持类型安全
- ✅ 必须写测试覆盖新功能

### 实施顺序
- ❌ 不跳过 Phase（N.1 → N.2 → N.3 依次进行）
- ❌ 不同时做多个 Phase
- ❌ 不在测试失败时继续下一个 Phase
- ✅ 必须按 detailed-phase-tasks-post-mvp.md 顺序
- ✅ 必须先通过测试再 commit

### Git 提交
- ❌ 不提交 node_modules, .env, data/*.db
- ❌ 不提交注释掉的代码或 TODO
- ✅ 每个 Phase 单独 commit
- ✅ Commit message: `feat: <功能描述>`
- ✅ 例如: `feat(persistence): implement raw event store`

---

## 🔧 工具命令

**测试**:
```bash
pnpm test           # 运行所有测试
pnpm test:unit      # 只运行单元测试
pnpm test:integration # 只运行集成测试
pnpm typecheck      # TypeScript 类型检查
pnpm lint           # ESLint 检查
```

**数据库检查**:
```bash
sqlite3 data/lethebot.db "SELECT COUNT(*) FROM raw_events"
sqlite3 data/lethebot.db "SELECT COUNT(*) FROM chat_messages"
sqlite3 data/lethebot.db "SELECT COUNT(*) FROM memory_records"
sqlite3 data/lethebot.db ".schema memory_records"
```

**启动测试**:
```bash
pnpm start          # 启动 Bot（需要 NapCat 连接）
```

---

## 🚨 Escalation 规则

**你应该 escalate 的情况**:

### 必须 escalate
1. **设计冲突**: 文档之间有矛盾，无法自行判断
2. **测试连续失败 3 次**: 同一个测试失败 3 次仍未解决
3. **外部依赖缺失**: 需要用户提供的资源（API key, credentials）
4. **安全决策**: 涉及权限、隐私、审计的模糊地带

### 不需要 escalate
1. **实现细节**: 如何组织代码、命名变量、函数拆分
2. **测试失败 1-2 次**: 调试并修复，不要立即 escalate
3. **依赖安装**: 自行 `pnpm install`
4. **简单 Bug**: 自行调试和修复

**Escalation 格式**:
```
[Escalation] Phase N.X | <简短描述>

问题：<详细说明>

已尝试：<你的尝试>

需要决策：<具体问题>
```

然后更新 `loop-state-post-mvp.md` 状态为 `blocked`，等待用户响应。

---

## 📝 状态更新

**loop-state-post-mvp.md** 是你和用户的共同视图。

**每完成一个 Phase，必须更新**:
```markdown
| N.1 | Data Persistence | ✅ complete | 2026-06-27 23:00 | 2026-06-27 23:45 | 3 | ✅ |
```

**每开始一个 Phase，必须更新**:
```markdown
| N.2 | Context & History | 🏃 in_progress | 2026-06-27 23:46 | - | 0 | - |
```

**遇到阻塞，必须更新**:
```markdown
| N.3 | Persona System | ⚠️ blocked | 2026-06-27 23:50 | - | 1 | - |
```

---

## 🎯 最终验收标准

**整个项目算完成的条件**:

### 功能验收
1. ✅ 所有数据库表有数据（不再为空）
2. ✅ Bot 能记住用户告诉它的信息
3. ✅ Bot 能在下次对话中引用历史
4. ✅ 群聊回复简短自然（<30 字）
5. ✅ 私聊回复友好详细
6. ✅ Bot 不再有客服腔（无"😊""抱歉"等）
7. ✅ 后台工作器自动运行

### 技术验收
8. ✅ 所有测试通过（单元 + 集成）
9. ✅ TypeScript 类型检查通过
10. ✅ ESLint 无错误
11. ✅ 所有 Phase 已 commit
12. ✅ 代码符合 AGENTS.md 规范

### E2E 场景验证
13. ✅ 私聊发送 "我叫 Alice"，Bot 确认
14. ✅ 1 分钟后问 "我叫什么"，Bot 回答 "Alice"
15. ✅ 群聊 @bot 问问题，回复 <30 字
16. ✅ 私聊问同样问题，回复可稍长

**满足所有条件，项目完成**。

---

## 🚀 开始执行

**第一步**:
```bash
# 1. 读取核心文档（10 个）
# 2. 运行 baseline 测试
pnpm test
pnpm typecheck

# 3. 检查数据库状态
sqlite3 data/lethebot.db "SELECT name, COUNT(*) FROM (
  SELECT 'raw_events' as name FROM raw_events
  UNION ALL SELECT 'chat_messages' FROM chat_messages
  UNION ALL SELECT 'memory_records' FROM memory_records
)"

# 4. 更新 loop-state-post-mvp.md，标记 Phase N.0 开始
# 5. 进入 Phase N.1
```

**持续工作**:
- 按 Phase 顺序执行
- 测试驱动开发
- 自主解决问题
- 只在必要时 escalate
- 保持状态透明

---

## 📖 参考示例

**Phase N.1 的实现示例**:

1. 读取 `docs/detailed-phase-tasks-post-mvp.md` Phase N.1 部分
2. 在 `src/index.ts` 中添加 `storeRawEvent()` 方法
3. 在 `handleEvent()` 开头调用
4. 写单元测试 `tests/unit/storage/raw-events.test.ts`
5. 运行测试确认通过
6. 手动发送消息测试
7. 查询数据库确认有数据
8. Git commit: `feat(persistence): implement raw event store`
9. 更新 loop-state-post-mvp.md
10. 进入 Task N.1.2

---

## ✨ 成功标志

当你完成所有工作时，你会看到：

```bash
$ pnpm test
✓ 所有测试通过 (300+ tests)

$ sqlite3 data/lethebot.db "SELECT COUNT(*) FROM memory_records"
> 5

$ cat docs/loop-state-post-mvp.md
Phase N.11 | Production Readiness | ✅ complete
```

此时，**LetheBot 从 MVP 进化为生产就绪状态**。

---

**开始时间**: (填写当前时间)
**目标完成**: 12-15 小时后
**工作模式**: 自主持续

**现在开始 Phase N.0: Post-MVP Foundation**

读取前 10 个文档，建立完整上下文，然后开始工作。
