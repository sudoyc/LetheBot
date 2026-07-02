# DeepSeek Real API E2E Tests

本文档说明 DeepSeek 真实 API 端到端测试的设计和使用方法。

## 概述

DeepSeek E2E 测试验证 LetheBot 与真实 DeepSeek API 的集成，包括：
- API 连通性和认证
- 上下文注入（记忆、历史、参与者）
- 工具调用和权限控制
- 错误处理和超时管理

## 文件结构

```
tests/
├── e2e/
│   └── deepseek-real-api.test.ts      # E2E 测试主文件
└── unit/
    └── e2e-helpers/
        └── deepseek-helpers.test.ts   # 辅助函数单元测试
```

## 配置 API Key

测试需要 DeepSeek API key 才能运行真实 API 测试。配置方法（按优先级）：

### 方法 1: 环境变量（推荐）

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
# 或者
export PI_API_KEY="sk-your-api-key"
```

### 方法 2: 文件配置

```bash
echo "sk-your-api-key" > ~/deepseek
```

### 方法 3: .env 文件

```bash
# .env.local
DEEPSEEK_API_KEY=sk-your-api-key
```

## 运行测试

### 运行所有 E2E 测试

```bash
pnpm test tests/e2e/
```

### 仅运行 DeepSeek E2E 测试

```bash
pnpm test tests/e2e/deepseek-real-api.test.ts
```

### 运行辅助函数单元测试

```bash
pnpm test tests/unit/e2e-helpers/
```

### 跳过真实 API 测试

如果没有配置 API key，测试会自动跳过真实 API 调用：

```bash
unset DEEPSEEK_API_KEY PI_API_KEY
pnpm test tests/e2e/deepseek-real-api.test.ts
```

输出示例：
```
⚠️  DeepSeek API key not found. Set DEEPSEEK_API_KEY or PI_API_KEY env var, or create ~/deepseek file.
   Real API tests will be skipped.
```

## 测试分类

### 1. 连通性测试
验证基础 API 连接和认证：
- API 可达性
- API key 验证
- 配置加载

### 2. 基础对话流程
验证简单对话交互：
- 完成对话回合
- 系统提示词注入
- 响应文本有效性
- Token 使用跟踪

### 3. 上下文注入
验证上下文构建和注入：
- 记忆上下文注入
- 对话历史注入
- 参与者上下文（私聊/群聊）
- Token 预算限制

### 4. 工具调用
验证工具注册和执行：
- 简单工具调用
- 工具参数传递
- 工具结果返回
- 策略门权限检查
- 受限工具拦截

### 5. 错误处理
验证异常情况处理：
- 无效 API key
- 网络超时
- 工具执行错误
- 不存在的工具

### 6. 辅助函数
验证测试辅助工具：
- ContextPack 构建
- 工具定义创建
- 配置加载逻辑

## 测试配置选项

通过环境变量自定义测试行为：

```bash
# 指定模型（默认: deepseek-v4-flash）
export DEEPSEEK_MODEL="deepseek-v4-pro"

# 指定 Base URL（默认: https://api.deepseek.com/v1）
export DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"

# 指定超时时间，毫秒（默认: 30000）
export DEEPSEEK_TIMEOUT="45000"
```

## 测试数据

### 测试用 ContextPack

```typescript
const contextPack = createTestContextPack({
  withMemory: true,        // 包含记忆块
  withHistory: true,       // 包含历史消息
  conversationType: 'private', // 'private' | 'group'
  userMessage: '你好',     // 用户消息内容
});
```

### 测试工具

**简单工具（无权限限制）：**
```typescript
const echoTool = createTestTool({
  requiresPolicy: false,
  shouldFail: false,
});
```

**受限工具（需要管理员权限）：**
```typescript
const adminTool = createTestTool({
  requiresPolicy: true,
  shouldFail: false,
});
```

## CI/CD 集成

### GitHub Actions 示例

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e-deepseek:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install
      - name: Run DeepSeek E2E tests
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        run: pnpm test tests/e2e/deepseek-real-api.test.ts
        continue-on-error: true
```

### 成本控制建议

1. 使用 `deepseek-v4-flash` 模型（成本最低）
2. 限制并发测试数量
3. 仅在 main 分支或手动触发时运行真实 API 测试
4. PR 中默认跳过真实 API 测试

## 当前状态

### ✅ 已完成
- 测试框架搭建
- 配置加载逻辑
- 辅助函数实现
- 工具注册和权限检查
- PolicyGate 集成测试
- 数据库初始化和迁移

### ⚠️ 待实现
- PiAdapter 真实实现（当前使用占位符）
- DeepSeek Provider 集成
- 真实 API 调用测试
- 流式响应测试
- 工具实际执行测试

## 故障排查

### API key 未找到

**问题:** 测试显示 "DeepSeek API key not found"

**解决:**
1. 检查环境变量: `echo $DEEPSEEK_API_KEY`
2. 检查文件: `cat ~/deepseek`
3. 确保 key 格式正确（以 `sk-` 开头）

### 测试超时

**问题:** 测试在 60 秒后超时

**解决:**
1. 检查网络连接
2. 增加超时配置: `export DEEPSEEK_TIMEOUT="90000"`
3. 使用更快的模型: `export DEEPSEEK_MODEL="deepseek-v4-flash"`

### Token 配额耗尽

**问题:** API 返回 429 错误

**解决:**
1. 等待配额重置
2. 使用专用测试 API key
3. 减少测试并发数
4. 跳过真实 API 测试: `unset DEEPSEEK_API_KEY`

## 开发指南

### 添加新测试用例

```typescript
it.skipIf(shouldSkipRealApiTests())('test name', async () => {
  const contextPack = createTestContextPack();
  const input: AgentTurnInput = { contextPack };
  const output = await reasoningCore!.run(input);

  expect(output.responseText).toBeDefined();
  expect(output.tokensUsed.total).toBeGreaterThan(0);
}, 60000); // 60秒超时
```

### 添加新测试工具

```typescript
const customTool: ToolRegistryEntry = {
  name: 'custom_tool',
  version: '1.0.0',
  description: 'Custom test tool',
  capabilities: ['read_context'],
  permissions: {
    allowedActors: ['user', 'admin'],
    allowedContexts: ['private_chat'],
  },
  evaluatorPolicy: 'bypass',
  auditLevel: 'summary',
  sandboxPolicy: {
    filesystem: 'none',
    network: 'none',
    execution: 'in_process',
  },
  outputSensitivity: 'normal',
  piSchema: {
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: {} },
  },
  handler: 'custom-handler',
};

toolRegistry.register(customTool);
```

## 相关文档

- [Pi Agent 架构](../../docs/pi-agent-integration.md)
- [工具注册规范](../../docs/tool-registry.md)
- [策略门设计](../../docs/policy-gate.md)
- [测试策略](../../docs/testing-strategy.md)

## 维护者

LetheBot 开发团队

最后更新: 2026-06-29
