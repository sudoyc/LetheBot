# Pi Agent Integration Guide

## Overview

LetheBot 使用 Pi Agent SDK (@earendil-works/pi-agent-core) 作为推理核心，支持多个 LLM 提供商。

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      LetheBot Application                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐   ┌──────────────┐ │
│  │ContextBuilder│───▶│  PiAdapter   │──▶│  PolicyGate  │ │
│  └──────────────┘    └──────────────┘   └──────────────┘ │
│                             │                              │
│                             ▼                              │
│                    ┌─────────────────┐                    │
│                    │ Pi Agent Core   │                    │
│                    │ (Real LLM API)  │                    │
│                    └─────────────────┘                    │
│                             │                              │
│                             ▼                              │
│                    ┌─────────────────┐                    │
│                    │  LLM Provider   │                    │
│                    │ (DeepSeek/etc)  │                    │
│                    └─────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. PiAdapter

位置：`src/pi/pi-adapter.ts`

核心职责：
- 包装 Pi Agent SDK
- ContextPack → Pi AgentMessage 转换
- 工具注册与权限集成
- 策略钩子（beforeToolCall/afterToolCall）
- 事件流处理

```typescript
const adapter = new PiAdapter({
  toolRegistry,
  policyGate,
  provider: 'openai',              // OpenAI, Anthropic, Google, etc.
  model: 'deepseek-v4-flash',      // Provider-specific model
  apiKey: 'sk-...',                // Or read from ~/deepseek
  baseUrl: 'https://api.deepseek.com',  // Optional: override endpoint
});
```

### 2. Tool Adapter

位置：`src/pi/tool-adapter.ts`

核心职责：
- LetheBot ToolRegistryEntry → Pi AgentTool 转换
- 工具执行包装
- 结果格式转换

```typescript
// Automatic conversion during runTurn
const piTools = convertToolsToPiFormat(
  toolRegistry.list(),
  (name) => toolRegistry.getHandler(name),
  { turnId, actor, invocationContext }
);
```

### 3. Message Conversion

ContextPack → Pi Messages：

```typescript
// 1. System prompt → agent.state.systemPrompt
agent.state.systemPrompt = input.systemPrompt;

// 2. Memory context → <context> block in first message
messages.push({
  role: 'user',
  content: [{
    type: 'text',
    text: `<context>\n${memoryContext}\n</context>\n${firstUserMessage}`
  }]
});

// 3. Recent messages → UserMessage[] (skip bot messages in MVP)
pack.recentMessages
  .filter(msg => !msg.isFromBot)
  .forEach(msg => {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `${msg.senderDisplayName}: ${msg.text}` }]
    });
  });
```

### 4. Policy Integration

PolicyGate 在工具执行前检查权限：

```typescript
// beforeToolCall hook
async beforeToolCall(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
  const result = this.policyGate.checkToolCall({
    toolName: context.toolCall.name,
    actor: this.currentActor,
    context: this.currentInvocationContext,
  });

  if (!result.allowed) {
    return { block: true, reason: result.reason };
  }

  if (result.requiresEvaluator) {
    return { block: true, reason: 'Tool requires evaluator review' };
  }

  return undefined; // Allow
}
```

## Configuration

### Environment Variables

```bash
# Provider (openai for OpenAI-compatible APIs)
PI_PROVIDER=openai

# Model name
PI_MODEL=deepseek-v4-flash

# API base URL (for custom endpoints)
PI_BASE_URL=https://api.deepseek.com

# API Key (optional - will fallback to ~/deepseek file)
PI_API_KEY=sk-...
```

### API Key Priority

1. `PI_API_KEY` environment variable
2. `~/deepseek` file (trimmed)
3. Empty string (will fail at runtime)

## Supported Providers

### DeepSeek (OpenAI-compatible)

```bash
PI_PROVIDER=openai
PI_MODEL=deepseek-v4-flash
PI_BASE_URL=https://api.deepseek.com
```

### OpenAI

```bash
PI_PROVIDER=openai
PI_MODEL=gpt-4-turbo
# PI_BASE_URL not needed (uses default)
```

### Anthropic Claude

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-3-5-sonnet-20241022
# PI_BASE_URL not needed (uses default)
```

### Google Gemini

```bash
PI_PROVIDER=google
PI_MODEL=gemini-1.5-pro
# PI_BASE_URL not needed (uses default)
```

## Testing

### Unit Tests

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts
```

20 tests covering:
- Construction and initialization
- ContextPack → Message conversion
- Memory context injection
- Tool registration with PolicyGate
- Event stream processing
- Error handling

### Integration Test

```bash
node test-deepseek.js
```

Sends a test message to DeepSeek API and verifies response.

Expected output:
```
🧪 Testing DeepSeek Integration

✅ API key loaded from /home/user/deepseek
🤖 Creating Pi Agent...
📤 Sending test message...
✅ Response received:
   Hi from DeepSeek!
🎉 DeepSeek integration working!
```

## Production Usage

### Starting the Bot

```bash
# Ensure configuration is set
cp .env.example .env
vim .env  # Configure PI_* variables

# Start LetheBot
pnpm start
```

### Logs

Pi Agent interactions are logged via pino:

```json
{
  "level": "info",
  "msg": "Pi Agent initialized",
  "provider": "openai",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com"
}
```

```json
{
  "level": "debug",
  "msg": "Pi response",
  "responseLength": 156,
  "toolCallCount": 0,
  "status": "completed"
}
```

## Design Decisions

### Why Not Hardcode Anthropic?

原始实现硬编码了 `getModel('anthropic', ...)`，限制了提供商选择。

修改后支持任意提供商：
- 用户可选择 DeepSeek、OpenAI、Claude、Gemini 等
- 支持自定义 baseUrl（OpenAI 兼容 API）
- 符合架构文档中的"提供商无关"原则

### Why Skip Historical Bot Messages?

Pi Agent 需要完整的 AssistantMessage 结构（包括 toolCalls 等）。

LetheBot 的 ContextPack.recentMessages 只存储文本，不保留工具调用历史。

MVP 选择：
- 跳过历史 bot 消息
- 只保留用户消息
- 生产版本应在数据库中存储完整 AssistantMessage

### Why PolicyGate in beforeToolCall?

Pi Agent 的 beforeToolCall 钩子在工具执行前调用，是 L0 策略强制执行的理想位置。

确保：
- 权限检查无法绕过
- evaluatorPolicy='bypass' 只跳过 LLM 评审，不跳过 L0 权限
- 审计链完整

## Troubleshooting

### API Key Not Found

```
❌ No API key found, Pi Agent may not work
```

**解决方案：**
1. 检查 `~/deepseek` 文件是否存在
2. 或设置 `PI_API_KEY` 环境变量

### Model Not Found

```
Error: Model 'deepseek-v4-flash' not found
```

**解决方案：**
检查提供商是否支持该模型名称。DeepSeek 需要使用 `provider=openai`（兼容模式）。

### Rate Limit

```
Error: 429 Too Many Requests
```

**解决方案：**
DeepSeek 有速率限制。等待或升级 API 计划。

### Connection Timeout

```
Error: connect ETIMEDOUT
```

**解决方案：**
1. 检查网络连接
2. 验证 `PI_BASE_URL` 是否正确
3. 检查防火墙/代理设置

## Future Enhancements

### Store Full AssistantMessage

当前 MVP 跳过历史 bot 消息。未来应存储完整的 AssistantMessage：

```typescript
interface StoredTurn {
  turnId: string;
  assistantMessage: AssistantMessage; // 包含 toolCalls
  userMessage: UserMessage;
  timestamp: Date;
}
```

### Stream Support

Pi Agent 支持流式响应。可以在 `runTurn` 中添加：

```typescript
async streamTurn(input: PiAdapterInput): Promise<AsyncIterator<PiEvent>> {
  // Subscribe to Pi events and yield
}
```

### Multi-turn Context

当前每次调用 `runTurn` 都是独立的。未来可支持多轮上下文：

```typescript
this.agent.prompt(messages); // Appends to existing conversation
```

### Tool Result Filtering

根据 `outputSensitivity` 过滤工具输出中的敏感信息：

```typescript
if (tool.outputSensitivity === 'secret_possible') {
  result = scanForSecrets(result);
}
```

## References

- [Pi Agent Core Documentation](https://github.com/earendil-works/pi)
- [LetheBot Architecture](./architecture.md)
- [Pi Integration Design](./pi-integration.md)
- [Tool Registry](./tool-registry.md)
- [Policy Gate](./security-privacy.md)
