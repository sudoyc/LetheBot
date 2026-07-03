# Local Container Acceptance

本文档用于本地启动 LetheBot + SnowLuma 双容器，验证容器构建、运行配置、健康检查，以及 SnowLuma OneBot WS 配置是否与 LetheBot 对齐。

本仓库保留两套本地验收栈：

- `docker-compose.local-acceptance.yml`：从 `../SnowLuma` 源码构建 SnowLuma，适合协议对接和开发调试。
- `docker-compose.snowluma-framework.yml`：使用 SnowLuma Docker Framework 镜像，内置 Linux QQ、Xvfb、VNC/noVNC，适合扫码登录和真实 QQ 收发验收。

## 适用范围

这个 compose 目标是本地验收，不是生产部署模板：

- LetheBot 使用 `PI_PROVIDER=mock`，不会调用真实模型。
- LetheBot 通过 `ONEBOT_TRANSPORT=ws` 连接 `ws://snowluma:3001/`。
- SnowLuma 的 WebUI 暴露在 `http://localhost:5099`。
- Framework 栈的 QQ 扫码桌面暴露在 `http://localhost:6081/`。
- SnowLuma OneBot HTTP / WS 端口分别暴露在 `3000` / `3001`。
- Compose 会把 SnowLuma 配置写到 `./data/snowluma-config`，把 LetheBot SQLite 写到 `./data/lethebot-local-acceptance.db`。

注意：SnowLuma 的 OneBot adapter 是账号会话级的；没有可用 QQ / SnowLuma session 时，SnowLuma WebUI 可以启动，但 `3001` 不一定已经监听，LetheBot `/healthz` 可能显示 `adapter.ready=false`。完整 QQ 收发验收请使用 Framework 栈并在 noVNC 里扫码登录 QQ。

## 前置条件

- Docker Compose v2。
- LetheBot 位于 `~/projects/LetheBot`。
- SnowLuma 位于同级目录 `~/projects/SnowLuma`。

Compose 文件通过 `../SnowLuma` 作为 SnowLuma build context；如果路径不同，需要编辑 `docker-compose.local-acceptance.yml` 中 `snowluma.build.context` 和 `dockerfile`。

## 启动

### 源码构建栈（协议开发）

首次构建并启动：

```bash
docker compose -f docker-compose.local-acceptance.yml up --build
```

后台启动：

```bash
docker compose -f docker-compose.local-acceptance.yml up -d --build
```

查看日志：

```bash
docker compose -f docker-compose.local-acceptance.yml logs -f snowluma lethebot
```

停止并保留数据：

```bash
docker compose -f docker-compose.local-acceptance.yml down
```

停止并删除镜像外的持久数据前，手动删除 `./data/snowluma-*` 和 `./data/lethebot-local-acceptance.db`。

### Docker Framework 栈（扫码 / 真实 QQ 验收）

启动完整验收栈：

```bash
docker compose -f docker-compose.snowluma-framework.yml up -d --build
```

访问：

- QQ 扫码桌面：`http://localhost:6081/`
- SnowLuma WebUI：`http://localhost:5099/`
- LetheBot health：`http://localhost:6700/healthz`

如果 noVNC 要求密码，使用 `VNC_PASSWD`。首次进入 SnowLuma WebUI 时，用
`SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 登录并同意协议。QQ 扫码登录完成后，
SnowLuma 才会为该账号启动 OneBot HTTP / WS adapter；登录前 `3000` / `3001`
未监听、LetheBot health 显示 degraded 属于正常状态。

默认值：

```bash
VNC_PASSWD=vncpasswd
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=lethebot-local
ONEBOT_TOKEN=lethebot-local-token
```

Framework 栈数据落在：

- `./data/snowluma-framework-data`
- `./data/snowluma-framework-qq-config`
- `./data/snowluma-framework-qq-data`
- `./data/lethebot-snowluma-framework.db`

如需强制重置 OneBot token 配置：

```bash
SNOWLUMA_FRAMEWORK_OVERWRITE_ONEBOT_CONFIG=1 \
ONEBOT_TOKEN=lethebot-local-token \
docker compose -f docker-compose.snowluma-framework.yml up -d snowluma lethebot
```

如需强制重置 SnowLuma WebUI 访问令牌：

```bash
SNOWLUMA_FRAMEWORK_OVERWRITE_WEBUI_CONFIG=1 \
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=lethebot-local \
docker compose -f docker-compose.snowluma-framework.yml up -d snowluma
```

## 默认本地配置

Compose 默认使用以下非生产配置：

```bash
ONEBOT_TOKEN=lethebot-local-token
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=lethebot-local
LETHEBOT_BOT_QQ_ID=
```

如果当前目录 `.env` 或 shell 环境里已有这些变量，Docker Compose 会用已有值做变量替换。推荐显式指定本地验收 token：

```bash
ONEBOT_TOKEN=lethebot-local-token \
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=lethebot-local \
docker compose -f docker-compose.local-acceptance.yml up --build
```

群聊验收时建议设置机器人自己的 QQ 号，避免把 `@其他人` 当成 `@bot`：

```bash
LETHEBOT_BOT_QQ_ID=123456789 \
docker compose -f docker-compose.local-acceptance.yml up -d
```

## SnowLuma 配置种子

`snowluma` 容器启动时，如果 `./data/snowluma-config/onebot.json` 不存在，会生成一个本地验收配置：

- HTTP server: `0.0.0.0:3000/`
- WS server: `0.0.0.0:3001/`
- `accessToken` 与 `ONEBOT_TOKEN` 一致
- `messageFormat=array`

如果你在 WebUI 修改过配置，默认不会覆盖。需要重置时：

```bash
SNOWLUMA_ACCEPTANCE_OVERWRITE_ONEBOT_CONFIG=1 \
docker compose -f docker-compose.local-acceptance.yml up -d snowluma
```

## 验收步骤

1. 验证 compose 语法：

   ```bash
   docker compose -f docker-compose.local-acceptance.yml config --quiet
   ```

2. 启动双容器：

   ```bash
   docker compose -f docker-compose.local-acceptance.yml up -d --build
   ```

3. 打开 SnowLuma WebUI：

   ```bash
   open http://localhost:5099
   ```

   Linux 桌面没有 `open` 时，直接在浏览器访问该 URL。

4. 检查 LetheBot 进程健康：

   ```bash
   curl http://localhost:6700/healthz
   ```

   - 如果 SnowLuma OneBot WS 已经有账号会话并监听，期望 `status="ok"` 且 `checks.adapter.wsConnected=true`。
   - 如果只有 SnowLuma WebUI 启动、尚无账号会话，期望数据库健康，但 `status="degraded"` / `checks.adapter.ready=false`。

5. 检查 SnowLuma OneBot HTTP API（需要账号会话可用）：

   ```bash
   curl -X POST http://localhost:3000/get_login_info \
     -H "Authorization: Bearer ${ONEBOT_TOKEN:-lethebot-local-token}" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

6. 完整消息验收：在 SnowLuma 有真实账号会话后，用 QQ 私聊或群聊 `@bot` 发消息，观察 LetheBot 日志和 SQLite 写入。

## 常见问题

### `lethebot` 一直 degraded

优先看：

```bash
docker compose -f docker-compose.local-acceptance.yml logs -f lethebot snowluma
curl http://localhost:6700/healthz
```

常见原因：

- SnowLuma 尚无账号会话，OneBot WS server 未监听。
- `ONEBOT_TOKEN` 与 SnowLuma `config/onebot.json` 中的 `accessToken` 不一致。
- `LETHEBOT_BOT_QQ_ID` 未设置或设置错，群聊 @bot 判断不准确。

### 改了 SnowLuma OneBot token 后连接不上

保持这三处一致：

- shell / `.env` 中的 `ONEBOT_TOKEN`
- `./data/snowluma-config/onebot.json` 的 `accessToken`
- `lethebot` 容器环境里的 `ONEBOT_TOKEN`

可用下面命令重置 SnowLuma 本地验收配置：

```bash
SNOWLUMA_ACCEPTANCE_OVERWRITE_ONEBOT_CONFIG=1 \
ONEBOT_TOKEN=lethebot-local-token \
docker compose -f docker-compose.local-acceptance.yml up -d snowluma lethebot
```

### SnowLuma 镜像构建慢或失败

本 compose 从 `../SnowLuma` 源码构建 SnowLuma。首次构建需要安装依赖并执行 `pnpm build:all`。

如果失败，先在 SnowLuma 仓库确认源码能独立构建：

```bash
cd ../SnowLuma
corepack enable
pnpm install --frozen-lockfile
pnpm build:all
```

也可以把 `snowluma` service 改成官方或本地预构建镜像，只保留相同端口、volume 和 `ONEBOT_TOKEN` 配置。
