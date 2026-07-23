# LetheBot 快速启动指南

> 当前权威入口是 [docs/README.md](./docs/README.md)，真实 QQ/Provider 验收请使用
> [Local Container Acceptance](./docs/local-container-acceptance.md) 和
> [Real Provider E2E Guide](./tests/e2e/README.md)。本指南不允许隐式读取本地凭据文件。

## 前置条件

- Node.js >= 22.0.0
- pnpm >= 9.0.0
- Provider API key（可选；仅在显式 opt-in 的真实 Provider 测试/运行中通过环境变量注入）
- NapCat 运行中（可选，用于 QQ 集成）

## 安装

```bash
cd ~/projects/LetheBot
pnpm install
```

## 配置

### 1. 创建配置文件

```bash
cp .env.example .env
```

### 2. 编辑 .env

```bash
# Log level
LOG_LEVEL=info

# Pi Agent (DeepSeek)
PI_PROVIDER=openai
PI_MODEL=deepseek-chat
PI_BASE_URL=https://api.deepseek.com/v1
# 真实运行时显式注入 PI_API_KEY；不要把 key 写入仓库或依赖 ~/deepseek fallback

# OneBot (NapCat)
ONEBOT_HTTP_URL=http://localhost:3000
LETHEBOT_PORT=6700

# Database
LETHEBOT_DB_PATH=./data/lethebot.db
```

### 3. 验证 Provider 连接（显式 opt-in）

```bash
LETHEBOT_RUN_REAL_API_TESTS=1 \
PI_API_KEY='<redacted-provider-key>' \
pnpm exec vitest run tests/e2e/pi-real-api.test.ts --silent
```

没有显式 `LETHEBOT_RUN_REAL_API_TESTS=1` 和 Provider key 时，该 suite 会跳过
真实网络调用。不要使用 root scratch `test-deepseek*.js` 作为验收证据。完整要求见
`tests/e2e/README.md`。

## 启动

### 开发模式

```bash
pnpm dev
```

### 生产模式

```bash
pnpm build
pnpm start
```

## 验证

### 1. 健康检查

```bash
curl http://localhost:6700/healthz
```

预期响应：
```json
{"status":"ok","version":"0.1.0"}
```

### 2. 发送测试事件

```bash
curl -X POST http://localhost:6700/onebot/event \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": 123456,
    "message": "你好",
    "time": 1609459200,
    "self_id": 789012,
    "message_id": 1
  }'
```

### 3. 检查日志

```bash
# 应该看到：
# - "Pi Agent initialized"
# - "AttentionEngine classified as needs_response"
# - "Pi response"
# - "Response sent"
```

## 通过 QQ 测试

### 1. 确保 NapCat 运行

```bash
# NapCat 应该监听在 http://localhost:3000
```

### 2. 配置 NapCat 回调

在 NapCat 配置中设置：
```json
{
  "http": {
    "enable": true,
    "host": "0.0.0.0",
    "port": 3000,
    "secret": "",
    "enableHeart": true,
    "enablePost": true,
    "postUrls": ["http://localhost:6700/onebot/event"]
  }
}
```

### 3. 发送 QQ 消息

给你的 bot QQ 号发送：
```
你好
```

Bot 应该回复 DeepSeek 生成的响应。

## 常见问题

### API Key 未配置

```
❌ No API key found, Pi Agent may not work
```

**解决方案：**通过受控的进程环境或 Docker Compose 环境显式注入
`PI_API_KEY`，然后重启 LetheBot。不要把 key 写入仓库，也不要创建
`~/deepseek` 这类隐式 fallback。

### NapCat 连接失败

```
Failed to send message: connect ECONNREFUSED
```

**解决方案：**
1. 检查 NapCat 是否运行
2. 验证 `ONEBOT_HTTP_URL` 配置
3. 检查防火墙设置

### 数据库初始化失败

```
Error: SQLITE_CANTOPEN: unable to open database file
```

**解决方案：**
```bash
mkdir -p data
chmod 755 data
```

### DeepSeek API 超时

```
Error: connect ETIMEDOUT
```

**解决方案：**
1. 检查网络连接
2. 验证 API key 有效性
3. 检查 API 额度

## 开发

### 运行测试

```bash
# 所有测试
pnpm test:run

# 特定测试文件
pnpm test:run tests/unit/pi/pi-adapter.test.ts

# 类型检查
pnpm typecheck

# Lint
pnpm lint
```

### 调试

```bash
# 设置 debug 日志级别
LOG_LEVEL=debug pnpm start
```

### 监控

查看实时日志：
```bash
tail -f logs/lethebot.log
```

## 架构

```
LetheBot
├── src/
│   ├── index.ts              # 主入口
│   ├── config/               # 配置加载
│   ├── logger/               # 日志
│   ├── storage/              # SQLite 存储
│   ├── gateway/              # OneBot 适配器
│   ├── attention/            # 注意力引擎
│   ├── context/              # 上下文构建
│   ├── pi/                   # Pi Agent 集成
│   │   ├── pi-adapter.ts     # PiAdapter (真实 LLM)
│   │   ├── tool-adapter.ts   # 工具转换
│   │   └── mock-pi.ts        # MockPi (测试用)
│   ├── tools/                # 工具注册表
│   ├── policy/               # 策略门
│   └── workers/              # 后台任务
├── tests/
│   ├── unit/                 # 单元测试
│   └── phase-acceptance/     # 阶段验收测试
├── docs/                     # 文档
├── migrations/               # 数据库迁移
└── .env                      # 配置文件
```

## 下一步

1. ✅ 通过 QQ 测试基本对话
2. 📝 注册自定义工具
3. 🧠 配置记忆系统
4. 🔒 配置权限策略
5. 🚀 部署到生产环境

## 文档

- [架构文档](./docs/architecture.md)
- [Pi Agent 集成](./docs/pi-integration.md)
- [工具注册](./docs/tool-registry.md)
- [策略门](./docs/security-privacy.md)
- [记忆系统](./docs/memory-system.md)

## 支持

遇到问题？检查：
1. [Current Goal State](./docs/long-running-goal-state.md) - 最新证据和下一步
2. [Test Strategy](./docs/test-strategy.md) - 测试覆盖
3. [Troubleshooting](./docs/troubleshooting.md) - 常见问题
