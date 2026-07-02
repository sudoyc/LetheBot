# LetheBot 快速启动指南

## 前置条件

- Node.js >= 22.0.0
- pnpm >= 9.0.0
- DeepSeek API key（保存在 `~/deepseek` 文件）
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
PI_MODEL=deepseek-v4-flash
PI_BASE_URL=https://api.deepseek.com
# API key 会自动从 ~/deepseek 读取

# OneBot (NapCat)
ONEBOT_HTTP_URL=http://localhost:3000
LETHEBOT_PORT=6700

# Database
LETHEBOT_DB_PATH=./data/lethebot.db
```

### 3. 验证 DeepSeek 连接

```bash
node test-deepseek.js
```

预期输出：
```
🧪 Testing DeepSeek Integration
✅ API key loaded from /home/ycyc/deepseek
🤖 Creating Pi Agent...
📤 Sending test message...
✅ Response received:
   Hi from DeepSeek!
🎉 DeepSeek integration working!
```

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

### API Key 未找到

```
❌ No API key found, Pi Agent may not work
```

**解决方案：**
```bash
echo "sk-your-deepseek-api-key" > ~/deepseek
chmod 600 ~/deepseek
```

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
- [Pi Agent 集成](./docs/pi-agent-integration.md)
- [工具注册](./docs/tool-registry.md)
- [策略门](./docs/security-privacy.md)
- [记忆系统](./docs/memory-system.md)

## 支持

遇到问题？检查：
1. [Loop State](./docs/loop-state.md) - 最新开发状态
2. [Test Strategy](./docs/test-strategy.md) - 测试覆盖
3. [Troubleshooting](./docs/pi-agent-integration.md#troubleshooting) - 常见问题
