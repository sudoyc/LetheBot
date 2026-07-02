# Contributing to LetheBot

感谢你对 LetheBot 项目的关注。本文档描述了代码风格、提交规范、分支策略和测试要求。

## 目录

- [开发环境设置](#开发环境设置)
- [代码风格规范](#代码风格规范)
- [提交消息规范](#提交消息规范)
- [分支策略](#分支策略)
- [Pull Request 流程](#pull-request-流程)
- [测试要求](#测试要求)
- [文档要求](#文档要求)

---

## 开发环境设置

### 前置条件

- **Node.js**: >= 22.0.0
- **包管理器**: pnpm 9.0.0
- **TypeScript**: 5.7.2

### 快速启动

```bash
# 克隆仓库
git clone <repository-url>
cd LetheBot

# 安装依赖
pnpm install

# 复制环境配置
cp .env.example .env

# 运行类型检查
pnpm typecheck

# 运行 Linter
pnpm lint

# 运行测试
pnpm test
```

---

## 代码风格规范

### TypeScript 规范

#### 1. 类型声明

- **优先使用 `interface` 而非 `type`**，用于定义对象结构
- **使用 `type` 用于联合类型、交叉类型和别名**
- **避免使用 `any`**，生产代码中禁止 `any`（ESLint: `@typescript-eslint/no-explicit-any: error`）
- **可选地使用 `unknown` 代替 `any`**，并进行类型守卫检查

```typescript
// ✅ 推荐
export interface MemoryRecord {
  id: string;
  scope: 'global' | 'user' | 'group';
  content: string;
}

export type MemoryScope = 'global' | 'user' | 'group' | 'conversation';

// ❌ 避免
export type MemoryRecord = {
  id: string;
  scope: any; // 禁止使用 any
};
```

#### 2. 命名约定

- **文件名**: 小写 + 连字符 (`kebab-case`)
  - `memory-repository.ts`
  - `onebot-adapter.ts`
- **类名**: 大驼峰 (`PascalCase`)
  - `MemoryRepository`
  - `OneBotAdapter`
- **接口名**: 大驼峰，不使用 `I` 前缀
  - `MemoryRecord`（而非 `IMemoryRecord`）
- **函数和变量**: 小驼峰 (`camelCase`)
  - `buildContext`
  - `canonicalUserId`
- **常量**: 大写下划线分隔 (`UPPER_SNAKE_CASE`)
  - `VERSION`
  - `DEFAULT_LIMIT`
- **私有字段**: 下划线前缀（可选）
  - `private _db: Database.Database;`
  - 公共 getter: `get db() { return this._db; }`

#### 3. 函数与方法

- **显式返回类型**：公共 API 必须声明返回类型
- **异步函数**：返回 `Promise<T>`，使用 `async/await`
- **参数数量**：超过 3 个参数时，使用对象参数模式

```typescript
// ✅ 推荐
export async function buildContext(input: BuildContextInput): Promise<ContextPack> {
  // ...
}

// ✅ 单行箭头函数可省略 return
const isActive = (state: string): boolean => state === 'active';

// ❌ 避免：参数过多
function buildContext(
  turnId: string,
  conversationId: string,
  conversationType: string,
  recentMessages: any[],
  targetUserId?: string,
  groupId?: string
) { }
```

#### 4. 导入顺序

按以下顺序组织导入，使用空行分隔：

1. Node.js 内置模块
2. 第三方依赖
3. 本地类型定义
4. 本地模块

```typescript
// 1. Node.js 内置
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 2. 第三方依赖
import Database from 'better-sqlite3';
import { ulid } from 'ulidx';

// 3. 本地类型
import type { MemoryRecord } from '../types/memory';
import type { ContextPack } from '../types/context';

// 4. 本地模块
import { MemoryRepository } from '../storage/memory-repository';
import { getLogger } from '../logger/index';
```

#### 5. 注释规范

- **文件头注释**：每个文件顶部必须包含简短的模块说明

```typescript
/**
 * Memory Repository
 *
 * 内存记录的持久化操作
 */
```

- **JSDoc 注释**：公共 API 必须包含 JSDoc
- **行内注释**：使用 `//` 解释复杂逻辑

```typescript
/**
 * 检索内存记录（带过滤和可见性规则）
 */
async retrieve(filters: MemoryFilters): Promise<MemoryRecord[]> {
  // 可见性过滤
  if (filters.contextType === 'private') {
    query += ' AND visibility IN (?, ?, ?)';
    params.push('private_only', 'same_user_any_context', 'public');
  }
}
```

#### 6. 错误处理

- **使用类型安全的错误检查**
- **记录错误日志时包含上下文**

```typescript
try {
  await this.processEvent(event);
} catch (error) {
  logger.error({
    error: error instanceof Error ? {
      message: error.message,
      stack: error.stack,
      name: error.name,
    } : error,
    step: 'event_processing',
    eventId: event.id,
  }, 'Failed to process event');
  throw error;
}
```

#### 7. 严格模式配置

项目启用了 TypeScript 严格模式（`tsconfig.json`）：

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`
- `noUncheckedIndexedAccess: true`

所有新代码必须通过严格检查。

---

## 提交消息规范

### Conventional Commits

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### 提交类型（Type）

| Type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(memory): add memory extraction worker` |
| `fix` | 修复 Bug | `fix(gateway): handle null message content` |
| `docs` | 文档更新 | `docs: update API documentation` |
| `test` | 测试相关 | `test(e2e): add full memory cycle E2E tests` |
| `refactor` | 重构（不改变功能） | `refactor(storage): simplify query builder` |
| `perf` | 性能优化 | `perf(memory): optimize retrieval query` |
| `style` | 代码格式（不影响逻辑） | `style: format code with prettier` |
| `chore` | 构建/工具变更 | `chore: update dependencies` |

### 作用域（Scope）

常用模块名作为作用域：

- `memory` - 记忆系统
- `storage` - 存储层
- `gateway` - OneBot 网关
- `attention` - 注意力引擎
- `context` - 上下文构建器
- `pi` - Pi Agent 适配器
- `tools` - 工具注册表
- `policy` - 策略门
- `workers` - 后台工作器
- `cli` - 命令行工具
- `types` - 类型定义
- `config` - 配置系统
- `test` - 测试相关

### 主题（Subject）

- **使用祈使句**："add" 而非 "added" 或 "adds"
- **小写开头**
- **不超过 70 字符**
- **不使用句号结尾**

### 提交消息示例

```bash
# 功能开发
feat(memory): implement memory extraction worker
feat(workers): add background worker scheduler

# Bug 修复
fix(test): correct chat_messages schema fields
fix(gateway): handle missing sender_id gracefully

# 文档更新
docs: add troubleshooting guide
docs: update loop state after Phase N.3

# 测试
test(e2e): add full memory cycle E2E tests
test(memory): add memory retrieval integration tests

# 重构
refactor(storage): extract query builder to separate class
```

---

## 分支策略

### 主分支

- **`main`**: 稳定的生产分支，所有提交必须通过 PR 合并
  - 保护规则：禁止直接推送
  - 要求：通过所有测试 + Code Review

### 开发流程

1. **从 `main` 创建特性分支**

```bash
git checkout main
git pull origin main
git checkout -b feat/memory-export-api
```

2. **分支命名规范**

```
<type>/<short-description>
```

示例：
- `feat/memory-export-api`
- `fix/null-pointer-in-context-builder`
- `docs/contributing-guide`
- `test/e2e-conversation-flow`
- `refactor/simplify-tool-registry`

3. **开发并提交**

```bash
# 小步提交，保持每个提交可独立编译和测试
git add src/memory/export.ts
git commit -m "feat(memory): add export API skeleton"

git add tests/unit/memory/export.test.ts
git commit -m "test(memory): add export API unit tests"
```

4. **推送并创建 PR**

```bash
git push origin feat/memory-export-api
# 在 GitHub/GitLab 上创建 Pull Request
```

---

## Pull Request 流程

### 创建 PR

1. **标题**：遵循提交消息规范（通常与最主要的提交一致）
2. **描述**：包含以下内容
   - **目的**：为什么做这个改动
   - **改动内容**：主要修改了什么
   - **测试**：如何验证功能正常
   - **相关 Issue**：关联的 Issue 编号

### PR 描述模板

```markdown
## 目的

实现记忆导出功能，支持用户导出个人记忆数据为 JSON 格式。

## 改动内容

- 新增 `MemoryRepository.exportUserMemory()` 方法
- 新增 CLI 命令 `lethebot memory export`
- 添加单元测试和集成测试

## 测试

- ✅ 所有现有测试通过
- ✅ 新增 12 个单元测试
- ✅ 新增 2 个集成测试
- ✅ 手动测试：`pnpm cli memory export --user user-123`

## 相关 Issue

Closes #42
```

### Code Review 检查清单

Reviewer 应检查：

- [ ] 代码符合项目风格规范
- [ ] 类型定义完整，无 `any`
- [ ] 公共 API 有 JSDoc 注释
- [ ] 包含充分的单元测试
- [ ] 测试覆盖率未下降
- [ ] 无明显性能问题
- [ ] 错误处理完善
- [ ] 日志记录合理

### 合并要求

- ✅ 所有测试通过（`pnpm test:run`）
- ✅ 类型检查通过（`pnpm typecheck`）
- ✅ Linter 检查通过（`pnpm lint`）
- ✅ 至少 1 名 Reviewer 批准
- ✅ 无未解决的讨论

---

## 测试要求

### 测试分类

LetheBot 使用三层测试策略：

1. **单元测试** (`tests/unit/`)
2. **集成测试** (`tests/integration/`)
3. **E2E 测试** (`tests/e2e/`)

### 覆盖率要求

| 类型 | 覆盖率目标 | 说明 |
|------|-----------|------|
| 单元测试 | ≥ 80% | 核心逻辑必须达到 90%+ |
| 集成测试 | 关键路径 100% | 数据库交互、外部 API 调用 |
| E2E 测试 | 主要用户场景 | 完整的用户对话流程 |

### 单元测试

- **位置**: `tests/unit/<module>/<file>.test.ts`
- **工具**: Vitest
- **原则**:
  - 测试纯函数和单一模块
  - Mock 外部依赖（数据库、网络、文件系统）
  - 每个测试独立，可并行运行
  - 测试边界条件和错误场景

**示例**：

```typescript
import { describe, it, expect } from 'vitest';
import { calculateTokenBudget } from '../../src/context/token-budget';

describe('calculateTokenBudget', () => {
  it('should return default budget when no messages', () => {
    const budget = calculateTokenBudget([], []);
    expect(budget.total).toBe(8000);
  });

  it('should reduce budget based on message length', () => {
    const messages = [
      { text: 'a'.repeat(1000), senderId: 'user-1' },
    ];
    const budget = calculateTokenBudget(messages, []);
    expect(budget.remaining).toBeLessThan(8000);
  });
});
```

### 集成测试

- **位置**: `tests/integration/<feature>.test.ts`
- **工具**: Vitest + 真实数据库（临时文件）
- **原则**:
  - 测试多个模块协作
  - 使用真实数据库（每个测试独立数据库文件）
  - 测试数据持久化和检索
  - 测试事务和并发场景

**示例**：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database';
import { MemoryRepository } from '../../src/storage/memory-repository';
import { rmSync, existsSync } from 'node:fs';

describe('Memory Retrieval Integration', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  const testDbPath = '/tmp/test-memory-retrieval.db';

  beforeEach(() => {
    if (existsSync(testDbPath)) rmSync(testDbPath);
    db = initDatabase({ path: testDbPath });
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) rmSync(testDbPath);
  });

  it('should retrieve memories with visibility filtering', async () => {
    // 创建记忆
    await repo.create({
      scope: 'user',
      canonicalUserId: 'user-1',
      visibility: 'private_only',
      content: 'secret data',
      // ...
    });

    // 在私聊中检索
    const memories = await repo.retrieve({
      canonicalUserId: 'user-1',
      contextType: 'private',
    });

    expect(memories.length).toBeGreaterThan(0);
  });
});
```

### E2E 测试

- **位置**: `tests/e2e/<scenario>.test.ts`
- **工具**: Vitest + 完整系统栈
- **原则**:
  - 模拟完整用户场景
  - 从事件输入到响应输出
  - 验证数据一致性
  - 测试关键用户路径

**示例**：

```typescript
describe('E2E: Full Memory Cycle', () => {
  it('should complete: user message → extract → store → retrieve → use', async () => {
    // 1. 用户陈述
    const userMessage = '我喜欢喝咖啡';
    const botResponse = '知道了';

    // 2. 提取记忆
    await memoryExtractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: 'user-1',
      userMessage,
      botResponse,
    });

    // 3. 验证存储
    const stored = await memoryRepo.retrieve({ canonicalUserId: 'user-1' });
    expect(stored.length).toBeGreaterThan(0);

    // 4. 构建上下文（检索记忆）
    const context = await contextBuilder.buildContext({
      conversationId: 'conv-1',
      targetUserId: 'user-1',
      // ...
    });

    // 5. 验证记忆被使用
    expect(context.memory.retrievedFacts).toContainEqual(
      expect.objectContaining({ content: userMessage })
    );
  });
});
```

### 运行测试

```bash
# 运行所有测试
pnpm test

# 运行单次测试（CI 模式）
pnpm test:run

# 运行特定测试文件
pnpm test tests/unit/memory/repository.test.ts

# 生成覆盖率报告
pnpm test:run --coverage

# 监视模式（开发时使用）
pnpm test --watch
```

### 测试文件命名

- 单元测试：`<module>.test.ts`
- 集成测试：`<feature>-integration.test.ts` 或 `<feature>.test.ts`
- E2E 测试：`<scenario>.test.ts`

### 新功能测试要求

每个 PR 必须包含：

- ✅ **单元测试**：新增的纯函数和类方法
- ✅ **集成测试**：新增的数据库操作或跨模块交互
- ✅ **E2E 测试**（可选）：新增的用户场景

如果修改了现有功能，必须更新对应的测试。

---

## 文档要求

### 代码文档

- **所有公共 API** 必须包含 JSDoc 注释
- **复杂算法** 添加行内注释解释逻辑
- **类型定义** 添加说明注释

### 项目文档

当添加新功能时，更新以下文档（如适用）：

- `README.md` - 主要功能描述
- `docs/architecture.md` - 架构设计
- `docs/examples/` - 使用示例
- `docs/troubleshooting.md` - 常见问题

### 更新日志

重大变更需要在 `CHANGELOG.md` 中记录（如果存在）。

---

## 许可证

本项目采用 MIT 许可证。提交代码即表示你同意将贡献内容以相同许可证发布。

---

## 问题与讨论

- **Bug 报告**: 使用 GitHub Issues
- **功能请求**: 使用 GitHub Issues 并添加 `enhancement` 标签
- **技术讨论**: 使用 GitHub Discussions 或项目内部沟通渠道

---

感谢你的贡献！🎉
