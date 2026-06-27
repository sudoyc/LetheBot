# Deployment Guide

本文档描述如何将 LetheBot 从开发环境部署到生产环境。

## 前置要求

- Node.js 18+
- pnpm 8+
- SQLite 3.35+
- （可选）NapCat 实例（用于真实 QQ 连接）
- （可选）Pi API 密钥（用于真实推理能力）

## 快速开始（开发模式）

开发模式使用 MockPi 和 FakeOneBot，无需真实 API 密钥或 NapCat 实例。

```bash
# 1. 克隆仓库
git clone <repository-url>
cd LetheBot

# 2. 安装依赖
pnpm install

# 3. 创建 .env 文件
cp .env.example .env

# 4. 运行测试
pnpm test:run

# 5. 类型检查
pnpm typecheck

# 6. 代码检查
pnpm lint
```

## 生产部署

### 1. 配置环境变量

创建 `.env` 文件并配置以下变量：

```bash
# 基础配置
NODE_ENV=production
LOG_LEVEL=info

# 数据库
DATABASE_PATH=./data/lethebot.db

# Pi API（真实推理核心）
PI_API_KEY=your_pi_api_key_here
PI_API_ENDPOINT=https://api.pi.ai/v1

# NapCat / OneBot（真实 QQ 连接）
ONEBOT_WS_URL=ws://localhost:3001
ONEBOT_ACCESS_TOKEN=your_onebot_access_token

# 安全
OWNER_QQ_ID=123456789  # 机器人所有者的 QQ 号

# 保留策略
RAW_EVENT_RETENTION_DAYS=30
CHAT_MESSAGE_RETENTION_DAYS=90
MEMORY_RETENTION_DAYS=365
```

### 2. 从 MockPi 切换到真实 Pi API

当前实现使用 `MockPi` 作为测试桩。切换到真实 Pi API：

**步骤 A：获取 Pi API 密钥**

1. 访问 [Pi API 控制台](https://platform.pi.ai)
2. 创建新的 API 密钥
3. 将密钥添加到 `.env` 文件的 `PI_API_KEY`

**步骤 B：实现真实 PiSdkAdapter**

当前 `src/pi/mock-pi.ts` 是测试实现。创建真实适配器：

```typescript
// src/pi/real-pi.ts
import { Pi } from '@pi-sdk/client';
import type { ReasoningCore, AgentTurnInput, AgentTurnOutput } from './types';

export class RealPi implements ReasoningCore {
  private client: Pi;

  constructor(apiKey: string) {
    this.client = new Pi({ apiKey });
  }

  async run(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const response = await this.client.chat.completions.create({
      model: 'pi-2024',
      messages: this.formatMessages(input),
      tools: this.formatTools(input.toolRegistry),
    });

    return this.parseResponse(response);
  }

  // 实现消息格式化、工具格式化和响应解析
  // ...
}
```

**步骤 C：更新依赖注入**

在主入口文件中，根据环境变量选择 Pi 实现：

```typescript
// src/index.ts
import { config } from './config';
import { MockPi } from './pi/mock-pi';
import { RealPi } from './pi/real-pi';

const pi = config.piApiKey
  ? new RealPi(config.piApiKey)
  : new MockPi();
```

### 3. 从 FakeOneBot 切换到真实 NapCat

当前 `tests/fakes/fake-onebot.ts` 是测试网关。连接真实 NapCat：

**步骤 A：安装并启动 NapCat**

参考 [NapCat 文档](https://github.com/NapNeko/NapCatQQ) 安装和配置 NapCat。

确保 NapCat 运行在 `ws://localhost:3001` 或更新 `.env` 中的 `ONEBOT_WS_URL`。

**步骤 B：实现真实 OneBotAdapter**

```typescript
// src/gateway/onebot-adapter.ts
import WebSocket from 'ws';
import type { GatewayAdapter, InternalEvent } from './adapter';

export class OneBotAdapter implements GatewayAdapter {
  private ws: WebSocket;

  constructor(url: string, accessToken?: string) {
    this.ws = new WebSocket(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });

    this.ws.on('message', (data) => this.handleMessage(data));
  }

  private handleMessage(data: WebSocket.Data): void {
    const event = JSON.parse(data.toString());
    const internal = this.toInternalEvent(event);
    this.emit('event', internal);
  }

  // 实现 sendMessage, sendGroupMessage, addReaction 等方法
  // ...
}
```

**步骤 C：注册真实网关**

```typescript
// src/index.ts
import { OneBotAdapter } from './gateway/onebot-adapter';

const gateway = new OneBotAdapter(
  config.onebotWsUrl,
  config.onebotAccessToken
);

gateway.on('event', (event) => {
  // 处理事件
});
```

### 4. 数据库迁移

生产环境首次启动前，运行数据库迁移：

```bash
# 创建数据目录
mkdir -p ./data

# 运行迁移（手动或通过启动脚本）
sqlite3 ./data/lethebot.db < migrations/001_initial_schema.sql
```

### 5. 启动服务

```bash
# 生产模式启动
NODE_ENV=production pnpm start
```

## 治理命令

使用 CLI 管理记忆和审计：

```bash
# 列出所有活跃记忆
pnpm cli list-memory

# 列出特定用户的记忆
pnpm cli list-memory --user user-alice

# 禁用记忆
pnpm cli disable-memory <memory-id>

# 删除记忆
pnpm cli delete-memory <memory-id>

# 查看决策解释（Phase L+ 实现）
pnpm cli why <turn-id>
```

## 监控和日志

日志输出到 stdout（JSON 格式），可通过日志聚合工具（如 Loki、CloudWatch）收集。

```bash
# 查看日志
pm2 logs lethebot

# 或使用 journalctl（systemd）
journalctl -u lethebot -f
```

## 备份

定期备份 SQLite 数据库：

```bash
# 在线备份（不锁定数据库）
sqlite3 ./data/lethebot.db ".backup ./backups/lethebot-$(date +%Y%m%d).db"
```

## 安全建议

1. **不要提交 `.env` 文件到 Git**
   - `.env` 已在 `.gitignore` 中
   - 使用环境变量或密钥管理服务存储生产密钥

2. **限制数据库访问权限**
   ```bash
   chmod 600 ./data/lethebot.db
   ```

3. **启用审计日志**
   - 所有工具调用和高风险决策已记录审计日志
   - 定期检查 `audit_log` 表

4. **配置记忆保留策略**
   - 根据隐私要求调整 `.env` 中的保留天数
   - 实现定期清理脚本（Phase M 后续任务）

## 故障排查

### MockPi 仍在运行

检查依赖注入逻辑，确保 `PI_API_KEY` 环境变量正确设置并被读取。

### NapCat 连接失败

1. 检查 NapCat 是否运行：`curl http://localhost:3001/get_login_info`
2. 检查 WebSocket URL 和访问令牌是否正确
3. 查看日志中的连接错误

### 数据库锁定错误

SQLite WAL 模式应自动启用。如果仍有锁定问题：

```sql
-- 检查 WAL 模式
PRAGMA journal_mode;

-- 应返回 'wal'
```

## 下一步

- [ ] 实现真实 PiSdkAdapter（替换 MockPi）
- [ ] 实现真实 OneBotAdapter（替换 FakeOneBot）
- [ ] 添加健康检查端点
- [ ] 配置 systemd 服务或 pm2
- [ ] 设置日志轮转
- [ ] 实现数据库自动备份
- [ ] 添加 Prometheus 指标
