# Loop Engineering Readiness Check

**检查时间:** 2026-06-27
**目标:** 验证文档和 prompt 可以作为超长期 Claude Code `/loop` 的约束

---

## ✅ 基础验证

### 文件完整性
- [x] 32 个 markdown 文件
- [x] 所有 README 链接有效（30 个链接，0 个失效）
- [x] 所有关键 loop engineering 文件存在

### 关键文件大小
```
contracts.md                 15.7 KB  ✓
fake-gateway-design.md       11.0 KB  ✓
test-strategy.md             17.9 KB  ✓
sqlite-schema.md             13.6 KB  ✓
detailed-phase-tasks.md      20.8 KB  ✓
escalation-checklist.md       9.0 KB  ✓
loop-engineering-prep.md     12.3 KB  ✓
loop-goal-mainline.md         4.3 KB  ✓
loop-state.md                 1.3 KB  ✓
```

**总计:** ~104 KB 的可执行上下文文档

---

## ⚠️ 发现的问题

### 1. loop-goal-mainline.md 的文档顺序遗漏

**问题:** Prompt 让 agent 读取 12 个文档，但遗漏了 3 个关键可执行文档

**当前顺序:**
```
1. AGENTS.md
2. docs/README.md
3. docs/vision.md
4. docs/architecture.md
5. docs/architecture-flow-overview.md
6. docs/architecture-weight-assessment.md
7. docs/design-decisions.md
8. docs/mvp-roadmap.md
9. docs/tech-stack.md
10. docs/data-model.md
11. docs/security-privacy.md
12. docs/loop-engineering-prep.md
```

**缺少:**
- ❌ `docs/contracts.md` - 最关键的接口定义
- ❌ `docs/test-strategy.md` - P0 回归测试
- ❌ `docs/detailed-phase-tasks.md` - 任务分解

**影响:** Agent 不会读这 3 个文档，会在 Phase B/C 卡住

**建议修复:** 在 prompt 的文档列表后面补充这 3 个

---

### 2. loop-engineering-prep.md 第 76 行格式错误

**问题:** Section 6 标题格式错误

**当前:**
```markdown
5. State/checkpoint files
   ...

## 6. Agent operating rules    ← 这里应该是 6. 不是 ##
   - context budget discipline
```

**影响:** 文档结构不一致，可能影响 agent 理解层级

**建议修复:** 改成 `6. Agent operating rules` 或保持 `##` 但删掉编号

---

### 3. contracts.md 缺少对 detailed-phase-tasks.md 的引用

**问题:** Phase 2/3 的代码片段在 detailed-phase-tasks.md，但 contracts.md 没有提示

**影响:** Agent 实现时可能不知道有详细任务分解

**建议修复:** 在 contracts.md 末尾加一句：
```markdown
## Implementation Guidance

For detailed phase-by-phase tasks with exact file paths and code snippets, see `docs/detailed-phase-tasks.md`.
```

---

### 4. loop-state.md 的初始状态过于空泛

**问题:** loop-state.md 全是 "TBD"，没有给 agent 一个起点

**当前:**
```markdown
- Phase: not started
- Status: planning
- Started at: TBD
```

**影响:** Agent 第一次运行时需要填充太多信息

**建议修复:** 改成更具体的初始状态：
```markdown
- Phase: Phase 0 (Repository and Design)
- Status: design complete, ready for implementation
- Started at: (will be filled on first /goal run)
```

---

### 5. escalation-checklist.md 缺少"何时不 escalate"的具体例子

**问题:** 文档说了何时 escalate，但"何时不 escalate"只有抽象描述

**当前:**
```markdown
**Do NOT escalate for:**
- Routine implementation decisions (variable names, file organization within a module)
- Bug fixes with clear root cause
```

**建议增加:** 具体的"不要 escalate"的场景示例：
```markdown
**Examples of NOT escalating:**
- ✓ Choosing between `getUserId()` vs `getCanonicalUserId()` as function name
- ✓ Putting MemoryRepository in `src/memory/repository.ts` vs `src/memory/repo.ts`
- ✓ Using `async/await` vs `.then()` chains
- ✓ Adding a log line for debugging
- ✗ Choosing between memory auto-activation thresholds (MUST escalate)
```

---

## ✅ 优点验证

### 文档质量
- [x] **AGENTS.md:** 清晰的项目规则，78 行，简洁
- [x] **contracts.md:** 完整的 TypeScript interfaces，设计决策已记录
- [x] **test-strategy.md:** P0 回归测试明确，4 大类全覆盖
- [x] **sqlite-schema.md:** 完整 SQL，可直接执行
- [x] **detailed-phase-tasks.md:** Phase 2/3 任务粒度合适（10-30分钟）
- [x] **escalation-checklist.md:** 覆盖产品/安全/技术债决策

### Prompt 质量
- [x] 不要求"一次性完成"
- [x] 明确了 gates（pre-flight, revision, escalation, abort）
- [x] 明确了 execution profiles（6 种路径）
- [x] 要求 checkpoint 和 handoff
- [x] 禁止未经允许的 commit
- [x] 包含核心实现规则（15 条）

### 防护机制
- [x] Context degradation 处理
- [x] Escalation gate 明确定义
- [x] loop-state.md 作为跨 session checkpoint
- [x] 文档冲突处理规则："stop and record"
- [x] 测试失败重试上限：3 次

---

## 🔧 必须修复（阻塞性）

### Fix 1: 补充 prompt 文档列表 ⚠️ HIGH PRIORITY

**位置:** `docs/prompts/loop-goal-lethebot-mainline.md` 行 10-23

**修改:**
```diff
 Read these files first, in this order:

 1. AGENTS.md
 2. docs/README.md
 3. docs/vision.md
 4. docs/architecture.md
 5. docs/architecture-flow-overview.md
 6. docs/architecture-weight-assessment.md
 7. docs/design-decisions.md
 8. docs/mvp-roadmap.md
 9. docs/tech-stack.md
 10. docs/data-model.md
 11. docs/security-privacy.md
 12. docs/loop-engineering-prep.md
+13. docs/contracts.md
+14. docs/test-strategy.md
+15. docs/fake-gateway-design.md
+16. docs/sqlite-schema.md
+17. docs/detailed-phase-tasks.md
+18. docs/escalation-checklist.md
```

**理由:** 这 6 个文档是可执行的核心约束，不读会导致：
- Phase B 无法实现 contracts（不知道接口定义）
- Phase C 无法建表（不知道 schema）
- Phase D 无法写测试（不知道 FakeOneBot 接口）
- 所有 phase 无法知道何时 escalate

---

## 💡 建议修复（非阻塞）

### Fix 2: 修正 loop-engineering-prep.md 格式

**位置:** `docs/loop-engineering-prep.md` 行 76

**修改:** 保持一致的列表格式

---

### Fix 3: 初始化 loop-state.md

**位置:** `docs/loop-state.md`

**修改:** 给一个明确的起点而不是全 TBD

---

### Fix 4: 增加 contracts.md 的实现引用

**位置:** `docs/contracts.md` 末尾

**修改:** 添加到 detailed-phase-tasks.md 的引用

---

### Fix 5: 丰富 escalation-checklist.md 的"不 escalate"例子

**位置:** `docs/escalation-checklist.md` "When to Escalate" 章节

**修改:** 增加具体的对比例子

---

## 📊 超长期可行性评估

### ✅ 可以支撑超长期 loop 的部分

1. **文档覆盖度:** 95%
   - 架构、设计、contracts、schema、tests、tasks 全部覆盖
   - 缺少的 5%：Phase 4-7 的详细任务（有模板，可按需展开）

2. **约束明确度:** 90%
   - 核心规则清晰（AGENTS.md + prompt）
   - Escalation 边界明确
   - Gates 定义完整
   - 缺少的 10%：一些边缘场景的决策（可以在遇到时 escalate）

3. **Checkpoint 机制:** 85%
   - loop-state.md 存在
   - Handoff 规则明确
   - 缺少的 15%：没有示例 handoff（可以在第一次 checkpoint 时建立）

4. **防护机制:** 90%
   - Context degradation 检测
   - Escalation gate 阻止乱猜
   - Revision gate 限制重试
   - Abort gate 处理不可恢复错误
   - 缺少的 10%：没有自动 context 监控脚本（依赖 agent 自律）

### ⚠️ 潜在风险

1. **Agent 可能忽略文档**
   - **风险:** Agent 不读完所有文档就开始实现
   - **缓解:** Prompt 明确要求"Read these files first"，并且是第一条指令
   - **残留风险:** 低（Claude Code 通常遵守明确指令）

2. **Context 在 Phase 5+ 累积过重**
   - **风险:** Phase 5 之后 context 可能 >70%，需要 checkpoint
   - **缓解:** Prompt 要求"If context gets heavy, checkpoint and stop cleanly"
   - **残留风险:** 中（需要 agent 自我监控 context）

3. **Phase 4-7 任务未详细展开**
   - **风险:** Agent 到 Phase 4 时任务粒度变粗，可能一次做太多
   - **缓解:** Phase 2/3 的模板已建立，agent 可以按模板展开
   - **残留风险:** 中（依赖 agent 遵守"bite-sized tasks"原则）

4. **真实凭证缺失时的阻塞**
   - **风险:** Phase G (Pi API key) 或 Phase E (NapCat) 缺凭证时卡住
   - **缓解:** Escalation checklist 已定义处理方式（skip with warning）
   - **残留风险:** 低（有明确的 fallback）

5. **设计文档冲突**
   - **风险:** 多个文档对同一件事说法不一致
   - **缓解:** Prompt 要求"stop and record the conflict"
   - **残留风险:** 低（已有处理机制）

---

## 🎯 最终判断

### 可以启动 `/loop`：✅ 是，但需要先修复 Fix 1

**前提条件:**
1. ✅ 必须先应用 **Fix 1**（补充 6 个文档到 prompt）
2. ⚙️ 建议应用 Fix 2-5（提升质量，非必需）
3. ⚠️ 准备好在以下时刻介入：
   - Phase G/E 缺凭证时（agent 会 escalate）
   - Phase 5+ context 累积时（agent 应该 checkpoint）
   - 设计冲突时（agent 会 stop and record）
   - 重复测试失败时（agent 会 escalate）

### 预期 loop 行为

**理想路径:**
```
/loop 启动
  -> 读取 18 个文档
  -> 检查 repo 状态
  -> 初始化 loop-state.md
  -> Phase A: Repository foundation (pnpm init, TypeScript config, test setup)
  -> Phase B: Core contracts (实现 contracts.md 的 interfaces)
  -> Phase C: Storage foundation (实现 sqlite-schema.md)
  -> Phase D: Gateway simulator (实现 fake-gateway-design.md)
  -> ...每个 phase 结束时 checkpoint
  -> Phase G: 遇到 Pi API key，escalate "需要凭证"
  -> 你提供凭证或选择 skip
  -> 继续到 Phase M
```

**预期中断点:**
- Phase G: Pi API key（escalate）
- Phase E 或 M: 真实 NapCat（escalate 是否连接）
- Phase 5-7: Context 可能累积（checkpoint）
- 任意 phase: 设计冲突（stop and record）

**每个 phase 预期时长:**
- Phase A-B: 30-60 分钟
- Phase C-G: 1-2 小时/phase
- Phase H-L: 2-4 小时/phase
- Phase M: 需要多天（soak test）

**总预估:** 20-40 小时的 agent 实现时间 + 你的 escalation 响应时间

---

## 📝 修复建议优先级

### P0（必须修复才能启动）
- [ ] **Fix 1:** 补充 prompt 文档列表（6 个文档）

### P1（强烈建议）
- [ ] **Fix 2:** 修正 loop-engineering-prep.md 格式
- [ ] **Fix 3:** 初始化 loop-state.md 起点

### P2（可选）
- [ ] **Fix 4:** contracts.md 增加实现引用
- [ ] **Fix 5:** escalation-checklist.md 增加对比例子

---

## ✅ 结论

**文档和 prompt 的质量：9/10**

**可以作为超长期约束：是**

**前置条件：修复 Fix 1（5 分钟工作量）**

修复后，这套文档可以稳定支撑一个 20-40 小时的长期 `/loop`，并且有足够的 gates、escalation 和 checkpoint 机制来防止失控。

**你现在的选择:**
1. 我立即修复 Fix 1，然后你就可以启动 `/loop`
2. 你自己手动在启动 `/loop` 时补充那 6 个文档到读取列表
3. 我修复 Fix 1-5 全部，给你最完整的准备

**推荐：选择 1 或 3**
