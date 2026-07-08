# Deployment Guide

本文档描述如何将 LetheBot 从开发环境部署到受控的 QQ / SnowLuma / OneBot 试运行环境。

## 前置要求

- Node.js 22+
- pnpm 9+
- SQLite 3.35+
- （可选）SnowLuma 或其它 OneBot v11 兼容运行时（用于真实 QQ 连接）
- （可选）Pi/API provider 凭据（用于真实推理能力）

## 快速开始（开发模式）

开发模式使用本地数据库、Mock Pi runtime 和 FakeOneBot / HTTP fake tests，无需真实 API 密钥或真实 OneBot 运行时。

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm lint
pnpm test:run
```

## 生产 / 受控试运行配置

创建 `.env` 文件并配置以下变量。变量名应和当前 `src/config/index.ts` / `src/index.ts` 保持一致。

```bash
# 基础配置
NODE_ENV=production
LOG_LEVEL=info
LETHEBOT_TEST=false

# 数据库
LETHEBOT_DB_PATH=./data/lethebot.db
LETHEBOT_RAW_EVENT_RETENTION_DAYS=90
LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS=90
LETHEBOT_AUDIT_LOG_RETENTION_DAYS=90
LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS=365
LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS=90

# Pi runtime（src/index.ts 使用这些变量）
PI_PROVIDER=openai
PI_MODEL=deepseek-v4-flash
PI_BASE_URL=https://api.deepseek.com
PI_API_KEY=your_api_key_here

# SnowLuma / OneBot transport
ONEBOT_TRANSPORT=ws
ONEBOT_WS_URL=ws://localhost:3001/
ONEBOT_HTTP_URL=http://localhost:3000
ONEBOT_TOKEN=your_onebot_access_token

# Bot QQ id：用于群聊 CQ @ 精确匹配，避免把 @其他人 当成 @bot
LETHEBOT_BOT_QQ_ID=<bot-qq-id>

# LetheBot HTTP server
LETHEBOT_PORT=6700
LETHEBOT_HOST=0.0.0.0
LETHEBOT_HEALTH_PATH=/healthz
LETHEBOT_READINESS_PATH=/readyz
LETHEBOT_METRICS_PATH=/metrics
LETHEBOT_EVENT_PATH=/onebot/event
```

### SnowLuma / OneBot 配置要点

1. 推荐第一版使用 `ONEBOT_TRANSPORT=ws`，SnowLuma WebSocket server 地址写入 `ONEBOT_WS_URL`。
2. 如需 reverse HTTP 兼容模式，设置 `ONEBOT_TRANSPORT=http`，OneBot HTTP API 地址写入 `ONEBOT_HTTP_URL`，并把 SnowLuma `httpClients[].url` 配为：
   `http://<lethebot-host>:<LETHEBOT_PORT><LETHEBOT_EVENT_PATH>`。
3. 如果设置 `ONEBOT_TOKEN`：
   - LetheBot 出站 HTTP API 会发送 `Authorization: Bearer <ONEBOT_TOKEN>`。
   - LetheBot 出站 WS 会在 URL query 中设置 `access_token=<ONEBOT_TOKEN>`。
   - LetheBot 入站 reverse HTTP 同时接受 Bearer token 和 SnowLuma `X-Signature: sha1=<hmac>`。
4. `LETHEBOT_BOT_QQ_ID` 必须是机器人自己的 QQ 号；群聊中只有 `[CQ:at,qq=<bot-id>]` 会触发 `mentionsBot=true`。

## 数据库迁移

生产环境首次启动前创建数据目录。当前应用启动时会执行 `migrations/001_initial_schema.sql`，也可以手动初始化：

```bash
mkdir -p ./data
sqlite3 ./data/lethebot.db < migrations/001_initial_schema.sql
```

## 启动服务

```bash
pnpm build
NODE_ENV=production pnpm start
```

健康检查：

```bash
curl http://localhost:6700/healthz
```

健康响应会覆盖：

- `checks.database.ok/open`
- `checks.adapter.ready`
- adapter token/bot-id 是否已配置（不回显 token 值）

## 本地双容器验收

如需在本机同时启动 LetheBot 和 SnowLuma 容器，使用：

```bash
docker compose -f docker-compose.local-acceptance.yml up -d --build
```

详细步骤见 [`docs/local-container-acceptance.md`](./local-container-acceptance.md)。

## 部署脚本

当前脚本只生成部署资产，不自动启动服务；默认输出到显式 `outputDir` 或当前目录。测试应使用 `test-output/`，不要污染 repo root。

```bash
pnpm deploy:configure
pnpm deploy:docker
pnpm deploy:systemd
pnpm deploy:pm2
pnpm verify:onebot
pnpm verify:napcat
```

`pnpm verify:onebot` 会按 `ONEBOT_TRANSPORT` 检查当前 OneBot 运行时；`pnpm verify:napcat` 是兼容别名。

## 治理命令

使用 CLI 管理记忆和审计：

```bash
pnpm cli list-memory
pnpm cli list-memory --user user-alice
pnpm cli disable-memory <memory-id>
pnpm cli delete-memory <memory-id>
pnpm cli why <turn-id>
pnpm cli redact-display-profile <canonical-user-id>
```

## Fake-to-real parity checklist（R8）

默认 deterministic tests 必须继续使用 FakeOneBot / 本地 HTTP fake，不依赖真实 SnowLuma。真实 OneBot 运行时只用于显式配置后的受控 smoke / soak。

上线前逐项核对：

- [ ] FakeOneBot private message path 覆盖 raw event、chat message、Pi turn、reply sink。
- [ ] FakeOneBot group path 覆盖普通群聊静默、目标 @bot 触发、非目标 @ 不触发。
- [ ] OneBot HTTP event endpoint 在未配置 token 时允许 dev flow，在配置 `ONEBOT_TOKEN` 后拒绝无效 Bearer / SnowLuma 签名请求。
- [ ] OneBot HTTP/WS 出站 API 调用使用同一个 token。
- [ ] CQ `at` 只在匹配 `LETHEBOT_BOT_QQ_ID` 时设置 `mentionsBot=true`。
- [ ] 私聊/群聊 message id、sender role、group card、quote、media 被结构化保存，不把 CQ 控制码当成普通文本注入。
- [ ] `/healthz` 同时检查 DB 和 adapter readiness。
- [ ] 默认 `pnpm test:run` 不连接真实 SnowLuma；真实连接用 `pnpm verify:onebot` 或显式 soak 脚本。

## 监控和日志

日志输出到 stdout（JSON/pino 格式），可通过 Loki、journald、PM2 logs 等收集。
运行日志在写出前会经过结构化 redaction hook：secret-like 文本、
QQ/platform-ID-like 文本、平台 ID 数字字段、Error message/stack 都会被
脱敏。legacy/free-text 中经由非字母数字分隔符嵌入的
`legacy_qq-...` / `legacy_123456789` 形态也按 platform ID 脱敏。

关注字段：

- Gateway connection/readiness
- Received message IDs
- Agent turn IDs
- Context pack IDs / selected memory IDs
- Tool call IDs
- Worker job IDs
- Event processing failures

## 备份

定期备份 SQLite 数据库：

```bash
mkdir -p ./backups
sqlite3 ./data/lethebot.db ".backup ./backups/lethebot-$(date +%Y%m%d).db"
```

## 安全建议

1. 不提交 `.env`、logs、SQLite db、API key、QQ private identifiers。
2. 限制数据库文件权限：`chmod 600 ./data/lethebot.db`。
3. 生产 token/API key 不写入文档、测试 fixture 或 audit full payload。
4. 根据隐私要求配置 raw event / chat / memory retention。
5. 受控试运行先限制到一个 bot account、一个 QQ group、一个 SQLite 数据库。

## 故障排查

### Mock Pi 仍在运行

检查：

- `LETHEBOT_TEST=false`
- `PI_PROVIDER` 不是 `mock`
- `PI_API_KEY` 已设置，或 `~/deepseek` 文件存在（当前入口仍支持该本地 fallback）

### SnowLuma / OneBot 连接失败

```bash
# HTTP 无 token
curl -X POST http://localhost:3000/get_login_info

# HTTP 有 token
curl -X POST http://localhost:3000/get_login_info \
  -H "Authorization: Bearer $ONEBOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

同时检查：

- `ONEBOT_TRANSPORT` 是否为 `ws` 或 `http`。
- `ONEBOT_WS_URL` 是否为 SnowLuma WebSocket server 地址。
- `ONEBOT_HTTP_URL` 是否为 HTTP API 地址。
- SnowLuma reverse HTTP event URL 是否指向 LetheBot 的 `LETHEBOT_EVENT_PATH`。
- `LETHEBOT_BOT_QQ_ID` 是否为机器人自己的 QQ 号。
- LetheBot `/healthz` 中 `checks.database.ok` 和 `checks.adapter.ready` 是否为 true。

`pnpm verify:onebot` 和 deployment verification 输出会在显示前脱敏
secret-like 文本、token presence、QQ/platform-ID-like 文本，以及经由非字母数字
分隔符嵌入 legacy/free-text URL 或 OneBot API message 的
`legacy_qq-...` / `legacy_123456789` 形态。相邻的 `sk-...-qq-...` 片段会保留
secret 与 platform 两类 redaction marker，但不会显示原始值。真实 token、QQ 号和群号
仍不要复制到 issue、日志摘录或验收记录中。

### 数据库锁定错误

SQLite WAL 模式应自动启用。如果仍有锁定问题：

```sql
PRAGMA journal_mode;
```

应返回 `wal`。
