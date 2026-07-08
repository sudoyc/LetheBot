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
PI_PROVIDER=mock
PI_MODEL=mock
```

Framework 栈数据落在：

- `./data/snowluma-framework-data`
- `./data/snowluma-framework-qq-config`
- `./data/snowluma-framework-qq-data`
- `./data/lethebot-snowluma-framework.db`

使用真实 Pi / DeepSeek 验收时，不要把 API key 写入仓库。可从本地临时文件注入：

```bash
PI_PROVIDER=openai \
PI_MODEL=deepseek-v4-flash \
PI_BASE_URL="$(cat /tmp/pi_base_url)" \
PI_API_KEY="$(cat /tmp/pi_api_key)" \
LETHEBOT_BOT_QQ_ID=<bot-qq-id> \
docker compose -f docker-compose.snowluma-framework.yml up -d --build --force-recreate lethebot
```

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

1. 离线预检 compose 语法。这个步骤不需要真实 QQ session，也不会读取模型 API key：

   ```bash
   docker compose -f docker-compose.local-acceptance.yml config --quiet
   docker compose -f docker-compose.snowluma-framework.yml config --quiet
   ```

2. 启动双容器。协议开发可用源码构建栈；扫码/真实 QQ 收发验收优先用 Framework 栈：

   ```bash
   docker compose -f docker-compose.local-acceptance.yml up -d --build
   # 或：
   docker compose -f docker-compose.snowluma-framework.yml up -d --build
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

5. 检查 SnowLuma OneBot API（需要账号会话可用）。推荐先用仓库里的
   `pnpm verify:onebot`，它会按 `ONEBOT_TRANSPORT` 选择 WS 或 HTTP，并会隐藏
   token 值；显示的 URL、OneBot API message 和 troubleshooting 输出也会脱敏
   QQ/platform-ID-like 值，包括嵌在 legacy/free-text 路径中的
   `legacy_qq-...` / `legacy_123456789` 形态：

   ```bash
   ONEBOT_TRANSPORT=ws \
   ONEBOT_WS_URL=ws://localhost:3001/ \
   ONEBOT_HTTP_URL=http://localhost:3000 \
   ONEBOT_TOKEN="${ONEBOT_TOKEN:-lethebot-local-token}" \
   pnpm verify:onebot
   ```

   如果只想手动检查 HTTP API，可使用：

   ```bash
   curl -X POST http://localhost:3000/get_login_info \
     -H "Authorization: Bearer ${ONEBOT_TOKEN:-lethebot-local-token}" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

6. 完整消息验收：在 SnowLuma 有真实账号会话后，用 QQ 私聊或群聊 `@bot` 发消息，观察 LetheBot 日志和 SQLite 写入。真实验收只在本地显式执行，不属于默认 deterministic test gate。

   默认 deterministic gate 已用 Fake OneBot HTTP 覆盖私聊/群聊基础回复、私聊/群聊 CQ-string quote/media 元数据、群聊 segment-array `reply`/`at`/`image`/`record`/`text` 元数据、群聊 segment-array 引用同会话已存 bot 回复且无 `at` 的触发路径、群聊 segment-array 引用同会话普通成员消息时保持 silent 的边界、群聊 segment-array 跨群引用已存 bot 回复时保持 silent 的边界、群聊 segment-array 普通 text 段包含 bot QQ ID 但无 `at` 时保持 silent 的边界、群聊 segment-array `at all` 时保持 silent 的边界、群聊 segment-array 数字型 `at.data.qq` 精确命中 bot 时触发回复的边界、malformed boolean/object/array/null/empty `reply.id` / `at.qq` 被忽略且不污染 mention/quote metadata 的边界、malformed media `url` 值保留 media presence 但不写入污染 URL metadata 的边界、secret-like / QQ-like CQ-string 和 segment-array media URL 保留 media presence 但丢弃 URL 字段的边界、secret-like / QQ-like sender nickname/group-card metadata 在 normalized raw event 和 display profile/history 写入前脱敏的边界、未知 segment type 被忽略且不产生 metadata/Pi/context/action/outbound 副作用的边界、非字符串 `text.data.text` 被忽略且不污染 normalized message text 的边界、malformed segment entry / 非 object `data` container 不导致事件处理失败且不污染 metadata 的边界、supported private/group message 中顶层 `message` / `raw_message` 同时畸形时降级为空 normalized text、不产生 adapter diagnostic/Pi/context/action/outbound 副作用且不持久化 seeded secret/platform 片段的边界、未知 CQ-string tag 被忽略且不产生 metadata/Pi/context/action/outbound 副作用的边界、CQ-string `at all` 群体提醒不触发精确 @bot 回复的边界、CQ-string 空/缺失 `at.qq` / `reply.id` 参数不污染 mention/quote metadata 且 media tag 只保留 media presence 的边界、CQ-string HTML entity 转义在 text/media URL 中被规范解码且不改变精确 mention 触发边界、unsupported `notice` / `request` / `meta_event` / `message_sent` / unknown future post type 入站 payload、valid-JSON-but-non-object reverse HTTP payload、malformed reverse HTTP JSON payload、和 unsupported/malformed `message.sub_type` payload 不写 raw/chat/turn/context/action/execution rows 且不持久化 seeded secret/platform 字段的边界，以及私聊 segment-array `reply`/`image`/`record`/`text` 元数据。Fake OneBot WebSocket adapter 单测还覆盖 valid-JSON-but-non-object inbound packet、不匹配 pending `echo` 且不含 supported `post_type` 的 non-event object packet、携带匹配 pending `echo` 的 supported `post_type: "message"` packet 仍优先作为事件处理且 pending API request 保持等待真实 response object 的边界、`post_type: "message"` 但 unsupported/malformed `message_type` 的 packet，supported private/group packet 中顶层 `message` / `raw_message` 同时畸形的 packet，supported private/group packet 中顶层 `message_id` / `user_id` / `group_id` 畸形的 packet、supported private/group packet 中顶层 `time` 为 malformed string/object/array/boolean/null 的 packet、supported private/group CQ-string 和 segment-array media URL 含 secret-like / QQ-like 片段的 packet，以及 supported private/group packet 中 sender nickname/group-card display metadata 含 secret-like / QQ-like 片段的 packet、supported private/group segment-array malformed entry / 非 object `data` container 的 packet：不 emit adapter error、不污染 readiness、不增加 outbound send、不泄露 seeded secret/platform 片段到 readiness，并且不解析/移除无关 pending API response；unsupported/malformed `message_type` 或 `message.sub_type` packet 不 emit chat event，supported private/group malformed-content packet emit 空 normalized body 的 chat event，supported private/group malformed-identifier packet emit 使用 bounded local/unknown/fallback ID 的 chat event，supported private/group malformed-timestamp packet emit receipt-time fallback timestamp 的 chat event，supported private/group sensitive-media-url packet emit media presence 但丢弃 URL metadata，supported private/group malformed segment-array packet 忽略 malformed entries 并把非 object `data` containers 当作 empty data 的 chat event。真实 SnowLuma/QQ 验收仍需在本地会话中确认平台实际消息格式和发送链路，不要把 fake coverage 当成 live soak 证据。

   当前 deterministic e2e coverage 还明确验证了非正数/小数型 OneBot 顶层 `message_id` / `user_id` / `group_id` 会 fallback 到 bounded local/unknown identifier，不会持久化负数或小数形式的 synthetic platform ID，也不会触发 Pi/context/action/outbound 副作用。

   同一边界也覆盖 segment-array 元数据：非正数/小数型 `reply.id` / `at.qq` 会被忽略，不会生成 quote/mention metadata，不会触发精确 @bot 逻辑，也不会产生 Pi/context/action/outbound 副作用。

   Outbound send API response 也覆盖同类边界：非正数/小数型 `data.message_id` 在 HTTP 与 WebSocket send response 中都会 fallback 到 bounded `qq-sent-*` local ID，不会把 `qq--...`、`qq-0` 或小数形式的 synthetic platform message ID 交给 action execution；secret-like / QQ-like string `data.message_id` 在 HTTP 与 WebSocket send response 中也会 fallback；structured malformed HTTP 与 WebSocket `data.message_id`（object / array / boolean / null）同样 fallback 到 bounded `qq-sent-*`；malformed HTTP 与 WebSocket top-level response `data` container（secret/platform-containing string / array / boolean / null）也会 fallback 到 bounded `qq-sent-*`；WebSocket 覆盖还验证 matching pending WS request 会被正常清理，HTTP 与 WebSocket 覆盖都验证 returned ID/readiness 不回显 seeded secret/platform 片段。HTTP 与 WebSocket OneBot API error response 的 structured malformed `message` / `wording` diagnostic container（object / array）也覆盖为 bounded `Unknown error` fallback，不通过 thrown error/readiness 泄露 seeded secret/platform 片段或 `[object Object]`；WebSocket 覆盖还验证 matching pending WS request 被清理。HTTP API response 顶层 JSON container 若为 secret/platform-containing string、array、boolean 或 null，也会 fail closed 到 bounded `OneBot API error: Unknown error`，不会通过 thrown error/readiness 泄露 seeded 片段、`[object Object]` 或 raw `Cannot read properties` TypeError。WebSocket send API request 若没有收到 response，会在现有 30 秒 timeout 后清理 matching pending request，readiness 只记录 bounded `OneBot WebSocket API timeout: send_group_msg`，不回显 seeded target/platform identifier。 WebSocket close while API request pending 也会清理 matching pending request，以 bounded `OneBot WebSocket closed` 拒绝 pending send，并且 readiness 不泄露 close reason 中的 seeded secret/platform 片段。 本地 `adapter.stop()` shutdown path 也覆盖了 socket close failure 含 seeded secret/platform 片段时的 pending request cleanup、bounded rejection、stopped readiness 和 no replacement socket 边界。 WebSocket `socket.send()` 同步失败路径也覆盖 pending request cleanup、caller/readiness redaction、no raw seeded diagnostic leakage 和 no unhandled internal response-promise rejection。

   Outbound send target 也有 deterministic unit coverage：`send_private_msg.user_id` / `send_group_msg.group_id` 只接受 positive safe-integer QQ target，`0` 和 unsafe integer target 在发起 OneBot HTTP/WebSocket send 前被拒绝；WebSocket 覆盖还验证不会调用 `socket.send`、不会创建 pending WS API request，且 readiness 不回显 raw target value。

   先生成一份 redaction-first 验收记录模板：

   ```bash
   pnpm acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
   ```

   该模板只用于记录 redacted evidence。不要把它写回仓库，除非已经人工确认没有真实 QQ 号、群号、token、API key、cookie、二维码、私聊正文或群聊原文。

   evidence 文件路径本身也应使用非敏感名称，例如 `/tmp/lethebot-acceptance-evidence.md`。
   `local-acceptance-evidence` 脚本会 redacted 它自己输出的路径和错误，但普通
   `pnpm <script>` 可能先把完整命令参数回显到 stdout。如果路径或参数中可能包含
   token、QQ 号、群号、用户名等敏感片段，请先改用非敏感 `/tmp` 文件名，或使用
   `pnpm --silent`：

   ```bash
   pnpm --silent acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
   ```

   如果需要分享或归档填写后的 evidence 文件，先运行本地离线检查：

   ```bash
   pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
   # 如果路径名本身可能敏感：
   pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
   ```

   该检查只报告规则 ID、行号和计数，不回显命中的原始值；若发现 secret-like token、私钥/JWT、未脱敏 QQ/群号长数字、raw CQ tag、或 `raw message text:` 等未脱敏正文，会以非零状态退出。

   `local-acceptance-evidence` CLI 会显式拒绝格式错误的参数：`--out` / `--out=` 和 `--validate` / `--validate=` 缺少文件路径时失败，未知 option 会失败，模板模式下裸 positional 参数也会失败。生成模板可使用 `--out=/tmp/lethebot-acceptance-evidence.md` 或 `--out /tmp/lethebot-acceptance-evidence.md`；脚本自身输出的 parser error 会先做 redaction。

   记录 HTTP header 证据时，请写 `Authorization: Bearer <redacted-token>` 这类已脱敏占位值。validator 会接受明确 redacted 的 bearer 值，但 raw bearer token / API-key-like 值仍会被判定为 finding，且不会回显原始 token。嵌在 legacy identifier 中、位于非字母数字分隔符后的 `sk-...` 片段（例如 `_sk-...`）同样会被判定为 API-key-like finding；嵌在 legacy identifier 中、位于非字母数字分隔符后的 8–12 位 QQ/群号/平台号数字（例如 `_12345678901`）也会被判定为 platform-ID finding，并在 CLI 路径/错误输出中脱敏。CLI display redaction 也会处理 legacy/free-text 中的 prefixed platform identifiers，例如 `legacy_qq-...`，避免留下 `legacy_qq-` 这类部分脱敏残留。相邻 secret/platform 片段（例如 `sk-...-qq-...`）会按 platform-before-secret-after-platform 的显示顺序脱敏，确保输出同时保留 secret 和 platform 两类 redaction markers，但不暴露原始值。

   建议记录：

   - 日期、compose 文件、镜像/源码版本；
   - `curl http://localhost:6700/healthz` 的 redacted 结果；
   - `pnpm verify:onebot` 结果；
   - 私聊和群聊各一条消息的 `raw_events` / `chat_messages` / `agent_turns` / `action_executions` 行数或只含内部 ID 的截图；
   - `PRAGMA foreign_key_check;` 结果；
   - 不记录真实 QQ 号、群号、API key、token、私聊正文或群聊原文。

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
