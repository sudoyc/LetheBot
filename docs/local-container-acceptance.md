# Local Container Acceptance

本文档用于本地启动 LetheBot + SnowLuma 双容器，验证容器构建、运行配置、健康检查，以及 SnowLuma OneBot WS 配置是否与 LetheBot 对齐。

本仓库保留两套本地验收栈：

- `docker-compose.local-acceptance.yml`：从 `../SnowLuma` 源码构建 SnowLuma，适合协议对接和开发调试。
- `docker-compose.snowluma-framework.yml`：使用 SnowLuma Docker Framework 镜像，内置 Linux QQ、Xvfb、VNC/noVNC，适合扫码登录和真实 QQ 收发验收。

## 适用范围

这个 compose 目标是本地验收，不是生产部署模板：

- 源码构建栈固定使用 `PI_PROVIDER=mock`；Framework 栈也默认使用 mock，但允许通过显式环境变量注入真实 provider/model/credential。
- LetheBot 通过 `ONEBOT_TRANSPORT=ws` 连接 `ws://snowluma:3001/`。
- SnowLuma 的 WebUI 暴露在 `http://localhost:5099`。
- Framework 栈的 QQ 扫码桌面暴露在 `http://localhost:6081/`。
- SnowLuma OneBot HTTP / WS 端口分别暴露在 `3000` / `3001`。
- 源码构建栈把 SnowLuma 配置、数据和日志分别写到
  `./data/snowluma-config`、`./data/snowluma-data`、`./data/snowluma-logs`，把
  LetheBot SQLite 写到 `./data/lethebot/lethebot-local-acceptance.db`；Framework 栈使用
  下文列出的 `snowluma-framework-*` 目录和
  `lethebot-snowluma-framework.db`。

注意：SnowLuma 的 OneBot adapter 是账号会话级的；没有可用 QQ / SnowLuma session 时，SnowLuma WebUI 可以启动，但 `3001` 不一定已经监听，LetheBot `/healthz` 可能显示 `adapter.ready=false`。完整 QQ 收发验收请使用 Framework 栈并在 noVNC 里扫码登录 QQ。

授权边界：任何会创建、启动或重建 Framework `snowluma` service 的命令都会
挂载并消费持久化的 QQ / SnowLuma 登录会话，运行时还可能改写会话状态和配置。
这包括完整 Framework 栈的 `up` / `--build` / `--force-recreate`，以及下面两个
强制配置 reset。执行它们必须另有明确授权；仅获准启动或重建 LetheBot、使用
模型凭据、检查 Compose，都不包含该权限。没有该授权时，只能用 `--no-deps`
操作 `lethebot` service，不能启动或重建 `snowluma`。

## 前置条件

- Docker Compose v2。
- LetheBot 位于 `~/projects/LetheBot`。
- SnowLuma 位于同级目录 `~/projects/SnowLuma`。

Compose 文件通过 `../SnowLuma` 作为 SnowLuma build context；如果路径不同，需要编辑 `docker-compose.local-acceptance.yml` 中 `snowluma.build.context` 和 `dockerfile`。

LetheBot 容器默认使用非 root 的 `1000:1000`，Compose 可通过
`LETHEBOT_UID` / `LETHEBOT_GID` 映射到当前宿主用户。两份 Compose 都不会
自动创建缺失的 `./data/lethebot`，启动前先显式准备：

```bash
export LETHEBOT_UID="$(id -u)"
export LETHEBOT_GID="$(id -g)"
install -d -m 700 ./data/lethebot
```

旧版 root 容器留下的 SQLite 主库、WAL、SHM，无论当前 mode 是什么，都必须在 LetheBot 停止后
逐个 `chown` 给上述 UID/GID，再重建 LetheBot。不要对共享的 `./data` 做递归
`chown`，也不要因此放宽到 group/world readable；该目录还包含 SnowLuma 数据。
迁移后只把 `./data/lethebot` 挂入 LetheBot；SnowLuma 配置、QQ 状态和日志目录
不会出现在 `/app/data`。所有 checked Compose host ports 也只绑定
`127.0.0.1`，需要远程访问时应通过经过认证的隧道显式暴露。

### From old parent bind to dedicated LetheBot bind

从旧的父目录 bind 升级时，必须做一次停服路径迁移，不能只创建新目录后直接
启动，否则应用会在新路径创建一个看似“丢数据”的空库。下面以 Framework 栈
为例；源码栈把 compose 文件和 DB basename 分别替换为
`docker-compose.local-acceptance.yml` 与 `lethebot-local-acceptance.db`。保留升级前
使用的 Compose 和镜像引用，直到新容器验证完成；Framework 示例假定旧文件已
保存为 `./backups/docker-compose.snowluma-framework.pre-bind.yml`，且其中使用的
旧镜像引用仍可用。源码栈还要替换下面的 preserved Compose basename。不要用
`docker compose config` 保存它，因为渲染结果可能包含凭据。下面的移动函数要求
GNU/Linux `mv --no-clobber`；预检之后目标仍可能出现，因此每次移动都使用
no-clobber 并立即断言源文件已经消失：

```bash
set -eu
compose=docker-compose.snowluma-framework.yml
preserved_compose=./backups/docker-compose.snowluma-framework.pre-bind.yml
old_db=./data/lethebot-snowluma-framework.db
new_dir=./data/lethebot
new_db="$new_dir/lethebot-snowluma-framework.db"
backup_dir=./backups
backup_db="$backup_dir/lethebot-pre-bind-migration.db"
runtime_uid="${LETHEBOT_UID:-$(id -u)}"
runtime_gid="${LETHEBOT_GID:-$(id -g)}"

path_exists() {
  test -e "$1" || test -L "$1"
}

move_no_clobber() {
  source_path="$1"
  destination_path="$2"
  if ! path_exists "$source_path"; then
    ! path_exists "$destination_path" || {
      echo "destination appeared without a source file: $destination_path" >&2
      return 1
    }
    return 0
  fi
  mv --no-clobber --no-target-directory -- "$source_path" "$destination_path"
  ! path_exists "$source_path" || {
    echo "destination appeared; source was preserved: $destination_path" >&2
    return 1
  }
}

test -f "$preserved_compose"
docker compose -f "$compose" stop lethebot
test -f "$old_db"
for suffix in "" -wal -shm; do
  ! path_exists "${new_db}${suffix}" || {
    echo "destination SQLite file already exists; aborting" >&2
    exit 1
  }
done

install -d -m 700 "$new_dir" "$backup_dir"
test ! -e "$backup_db" && test ! -L "$backup_db" || {
  echo "backup SQLite file already exists; aborting" >&2
  exit 1
}
sudo chown "$runtime_uid:$runtime_gid" "$new_dir"
for suffix in "" -wal -shm; do
  test ! -e "${old_db}${suffix}" || sudo chown "$runtime_uid:$runtime_gid" "${old_db}${suffix}"
  test ! -e "${old_db}${suffix}" || sudo chmod 600 "${old_db}${suffix}"
done

pnpm ops:backup -- --db="$old_db" --out="$backup_db"

for suffix in "" -wal -shm; do
  move_no_clobber "${old_db}${suffix}" "${new_db}${suffix}"
done

pnpm ops:doctor -- --db="$new_db"
docker compose -f "$compose" up -d --build --no-deps --force-recreate lethebot
```

旧库若不是 root 所有，可以在确认当前用户拥有这些精确路径后省略 `sudo`；不要对
`./data` 递归操作。`ops:backup` 必须在停服后成功，且主库与当时仍存在的
WAL/SHM 必须在
同一个维护窗口处理。不要只复制 main DB，也不要在应用仍持有 SQLite handle 时
移动。若运行 UID/GID 与当前 shell 不同，以该 UID/GID 执行 `ops:backup` 和
`ops:doctor`，或授予操作者仅访问这些精确路径的权限。
任何 no-clobber 断言失败都必须保持 LetheBot 停止；目标不会被覆盖，但此前的
suffix 可能已经移动。核对两侧精确 main/WAL/SHM 集合并解决冲突后，才能重新
执行迁移或回滚，不能直接启动任一路径。

重建后验证实际身份、唯一应用数据挂载、目录和文件权限以及 metrics：

```bash
cid="$(docker compose -f "$compose" ps -q lethebot)"
docker inspect --format '{{.Config.User}} {{range .Mounts}}{{.Source}} -> {{.Destination}} {{end}}' "$cid"
stat -c '%u:%g %a %n' "$new_dir"
for suffix in "" -wal -shm; do
  test ! -e "${new_db}${suffix}" || stat -c '%u:%g %a %n' "${new_db}${suffix}"
done
curl -fsS http://127.0.0.1:6700/metrics >/dev/null
```

期望容器身份是所选 UID/GID，唯一应用数据 mount 是 host `data/lethebot` 到
`/app/data`，目录为 `0700`，现存 main/WAL/SHM 均为该 UID/GID 的 `0600`。
OneBot 尚未就绪时 `/healthz` 可以是 503、Docker 可以是 `unhealthy`；只要进程仍
运行且 metrics 为 200，这不是数据库迁移失败。

若新容器验证失败，先再次停止 LetheBot，再确认旧路径三个目标都不存在，然后按
精确 suffix 反向移动并用保留的旧 Compose/镜像启动；不要在 live handle 下反移：

```bash
set -eu
compose=docker-compose.snowluma-framework.yml
preserved_compose=./backups/docker-compose.snowluma-framework.pre-bind.yml
old_db=./data/lethebot-snowluma-framework.db
new_db=./data/lethebot/lethebot-snowluma-framework.db

path_exists() {
  test -e "$1" || test -L "$1"
}

move_no_clobber() {
  source_path="$1"
  destination_path="$2"
  if ! path_exists "$source_path"; then
    ! path_exists "$destination_path" || {
      echo "destination appeared without a source file: $destination_path" >&2
      return 1
    }
    return 0
  fi
  mv --no-clobber --no-target-directory -- "$source_path" "$destination_path"
  ! path_exists "$source_path" || {
    echo "destination appeared; source was preserved: $destination_path" >&2
    return 1
  }
}

test -f "$preserved_compose"
docker compose -f "$compose" stop lethebot
for suffix in "" -wal -shm; do
  ! path_exists "${old_db}${suffix}" || {
    echo "old SQLite target already exists; rollback aborted" >&2
    exit 1
  }
done
for suffix in "" -wal -shm; do
  move_no_clobber "${new_db}${suffix}" "${old_db}${suffix}"
done
docker compose -f "$preserved_compose" up -d --no-deps --force-recreate lethebot
```

如果移动后的文件集合不可信，把新路径下精确的 main/WAL/SHM 移入私有隔离目录，
确认旧路径及 sidecars 不存在，再按 `docs/operations.md` 的 stopped-service
`ops:restore` 流程从 `$backup_db` 恢复 `$old_db`。路径迁移不会替代 verified backup
或 schema rollback。

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

停止并删除源码构建栈镜像外的持久数据前，手动删除
`./data/snowluma-config`、`./data/snowluma-data`、
`./data/snowluma-logs` 和 `./data/lethebot/lethebot-local-acceptance.db`。不要用
`snowluma-*` 通配符，因为它也会匹配 Framework 栈的登录/运行数据目录。

### Docker Framework 栈（扫码 / 真实 QQ 验收）

启动完整验收栈会读取/消费已挂载的 QQ 登录会话，并可能更新 Framework 的
会话数据和 SnowLuma 配置。只有在得到上述独立授权后才能执行：

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
未监听、LetheBot health 显示 degraded 属于正常状态。LetheBot Compose
healthcheck 会按 `/healthz` 的 HTTP 状态判断，因此这段时间 Docker 会显示
`unhealthy`；这表示应用尚未就绪，不等于进程已经退出。

默认值：

```bash
VNC_PASSWD=vncpasswd
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=lethebot-local
ONEBOT_TOKEN=lethebot-local-token
PI_PROVIDER=mock
PI_MODEL=mock
LETHEBOT_BACKGROUND_SUMMARY_ENABLED=false
```

`LETHEBOT_BACKGROUND_SUMMARY_ENABLED=true` 会把保留的会话文本发送给配置的
Pi Provider 生成摘要。除非已明确授权该数据暴露，否则保持默认的 `false`。

Framework 栈数据落在：

- `./data/snowluma-framework-data`
- `./data/snowluma-framework-qq-config`
- `./data/snowluma-framework-qq-data`
- `./data/lethebot/lethebot-snowluma-framework.db`

使用真实 Pi / DeepSeek 验收时，不要把 API key 写入仓库。可从本地临时文件注入：

```bash
PI_PROVIDER=openai \
PI_MODEL=deepseek-v4-flash \
PI_BASE_URL="$(cat /tmp/pi_base_url)" \
PI_API_KEY="$(cat /tmp/pi_api_key)" \
LETHEBOT_BOT_QQ_ID=<bot-qq-id> \
docker compose -f docker-compose.snowluma-framework.yml up -d --build --no-deps --force-recreate lethebot
```

`docker-compose.local-acceptance.yml` 固定为 mock，不能用于完成态证据。
需要通过 `--require-complete` 的真实 provider 验收必须使用
`docker-compose.snowluma-framework.yml`，并显式注入非 mock provider/model 与凭据。

如需强制重写 Framework OneBot 配置，先取得允许改写 SnowLuma 配置和消费其
会话的额外授权。`SNOWLUMA_FRAMEWORK_OVERWRITE_ONEBOT_CONFIG=1` 不是只更新
token：入口脚本会整份重写 `config/onebot.json`，用固定 seed 替换已有的
HTTP/WS server/client、status command 和 notification 配置，WebUI 中的相关
自定义会丢失：

```bash
SNOWLUMA_FRAMEWORK_OVERWRITE_ONEBOT_CONFIG=1 \
ONEBOT_TOKEN=lethebot-local-token \
docker compose -f docker-compose.snowluma-framework.yml up -d snowluma lethebot
```

如需强制重建 SnowLuma WebUI auth 配置，也要先取得同样的额外授权。该标志会
删除整份 `config/webui.json`，启动时再用 bootstrap password 重新生成；既有
WebUI token/login 状态会失效：

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

如果你在 WebUI 修改过配置，默认不会覆盖。需要重置时要注意，该标志会整份
重写 `onebot.json`，不是只修改 `accessToken`；现有 network client/server、
status command、notification 等自定义都会被 seed 替换：

```bash
SNOWLUMA_ACCEPTANCE_OVERWRITE_ONEBOT_CONFIG=1 \
docker compose -f docker-compose.local-acceptance.yml up -d snowluma
```

## 验收步骤

1. 离线预检 compose 语法。这个步骤不需要真实 QQ session，也不会调用模型
   provider 或输出 API key。Compose 默认会读取项目 `.env`；要让纯语法预检连
   凭据文件都不解析，显式使用空 env file：

   ```bash
   docker compose --env-file /dev/null -f docker-compose.local-acceptance.yml config --quiet
   docker compose --env-file /dev/null -f docker-compose.snowluma-framework.yml config --quiet
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
   - 如果只有 SnowLuma WebUI 启动、尚无账号会话，期望数据库健康，但 `status="degraded"` / `checks.adapter.ready=false`；对应 LetheBot 容器状态应为 `unhealthy`，账号会话和 adapter 就绪后才转为 `healthy`。

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

   `pnpm verify:onebot` 是源码 checkout 命令。prune 过 devDependencies 的生产容器
   不包含 `tsx` / `src`，应直接运行已编译 verifier：

   ```bash
   docker compose --env-file /dev/null \
     -f docker-compose.snowluma-framework.yml exec -T lethebot \
     node dist/scripts/verify-napcat.js
   ```

   如果只想手动检查 HTTP API，可使用：

   ```bash
   curl -X POST http://localhost:3000/get_login_info \
     -H "Authorization: Bearer ${ONEBOT_TOKEN:-lethebot-local-token}" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

6. 完整消息验收：在 SnowLuma 有真实账号会话后，先用 QQ 私聊 bot；再在同一个受控群里发送一次精确 `@bot`，等待并保留该 bot 回复；最后用一个新的入站群消息直接回复该 bot 消息且不包含 `@bot`。观察 LetheBot 日志和 SQLite 写入。真实验收只在本地显式执行，不属于默认 deterministic test gate。

   **行为可用性 canary**

   基础收发只能证明 transport。群聊可靠性修复还必须在受控群里执行以下
   content-minimal 场景，并在发送前写下“当前消息应该回答谁/哪条消息”的预期：

   - 至少三名参与者交错发言，其中两人可使用相同的合成测试称呼；分别向 bot
     提出不同类别的短问题，确认回复没有接到另一人的未完成话题。
   - 分别测试精确 `@bot`、原生回复 bot（客户端自动带 `@` 也算）、无 mention
     的原生回复 bot，以及回复普通群友。前两类应回答精确目标；回复普通群友不应
     因 quote 本身触发 bot。
   - 在滚动 20 条消息之外保留一条受控 bot 回复，再原生回复它，确认 ContextPack
     使用受限同群定向查找，而不是猜最近消息。
   - 由管理员发送一条仅讨论配置、但不是命令且不 `@bot` 的陈述，确认不会因为
     关键词主动插话；再发送确定性 admin 命令，确认 authority/proactive 证据正确。
   - 连续发送普通 direct mention/reply/question 组合，确认不会仅因多个相关性信号
     进入 risk evaluator；另设一个明确需要治理的合成动作验证 evaluator fail-closed。
   - 分别验证“没有记忆效果”“只创建待审核 proposal”“治理后 active recall”三种
     回复措辞，并放入一条无关的 active memory。没有同一命题/主体/作用域/来源或
     same-turn effect 时不得声称已记住，proposal 只能称待审核；无关 memory 不得
     为当前声明背书。
   - 完成一个允许的私聊或同群记忆召回后重启 LetheBot 容器，再在新 turn 中复测；
     同时从另一群确认没有历史、quote、参与者或记忆越界。

   `BASIC_USABLE` 的现场门槛：

   - 所有预期 direct trigger 都有 durable turn；普通低风险 direct reply 不出现
     `invalid_structured_output` 导致的 failed admission；
   - 所有受控回复都命中预先声明的当前说话人/quote target，speaker/quote
     misattribution 为 0；
   - cross-group context/memory/action target 为 0；
   - unsupported durable-memory claim 为 0；
   - narrative admin-keyword unsolicited reply 为 0；
   - delivered reply 的 platform message ID、bot row、turn/context/decision/execution
     chain 完整，`integrity_check=ok` 且 `foreign_key_check` 无行；
   - direct delivered-reply p95 延迟不高于 15 秒。延迟通过不替代语义正确性。

   `TARGET_COMPLETE` 还要求未 mention 问题的 15 秒 recheck、120 秒 thread、人工
   回答取消、流量/频率预算、QQ `/memory`/`/why`、按群 summary opt-in、批准后
   restart recall 和完整行为矩阵全部通过。summary opt-in 需分别验证普通成员被
   拒绝、本群 owner/admin 或 bot owner 可变更、关闭立即停止入队和召回并取消
   pending job、保留记录仍可治理/删除、重新开启不补跑关闭期间窗口。

   现场记录只保存 scenario ID、预期/实际分类、计数、延迟分位数、内部链路是否
   存在以及 pass/fail。不要保存或复制群聊正文、昵称、QQ/群号、message ID、模型
   原始输出或数据库行。行为矩阵定义见 `docs/test-strategy.md`。

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

   真实收发验收后，可以用只读聚合摘要辅助填写 DB 证据，避免手工复制
   row payload、消息正文或平台 ID：

   ```bash
   pnpm --silent acceptance:db-summary -- --db=./data/lethebot/lethebot-snowluma-framework.db --require-acceptance-hints
   ```

   该命令输出包括生成时间、脱敏 DB 路径，以及 aggregate-only 的 integrity/FK、
   raw-event/chat/context/turn/action、memory record/source/revision、selected
   governed-memory context、conservative group-derived user memory、tool/reviewed-tool、
   failure/audit、acceptance-flow
   计数和布尔 evidence hints；不会输出 row IDs、
   QQ/群号、消息正文、memory 内容、tool input/output payload、tool error
   diagnostics 或 audit details。
   `--require-acceptance-hints` 会在 integrity/FK、private 与 group 任一路径的
   chat row、context trace、completed turn、successful action、同一 completed
   turn 上同时链接 context trace 与 successful action execution、该 turn
   使用自身 `context_pack_id` / `action_decision_id` 指向的 durable rows、
   且可追溯到同一路径 normalized chat row / `chat.message.received`
   gateway QQ raw event、并且 linked action execution 是带
   `executed_message_id` 的 delivered reply action（`reply_short`、`reply_full`、
   `reply_with_tool` 或 `ask_clarification`）、且该 message id 已持久化为
   同路径 `bot.response` / `bot-self` chat row；downgraded
   `send_folded_forward` text fallback 不计为 complete acceptance 的 delivered-reply
   success，因为真实 folded-forward node delivery 尚未实现；downgraded
   `react_only` face/text fallback 即使实际发送 fallback message 并持久化为
   `bot.response` traceability，也不计为 complete acceptance 的 delivered-reply
   success，因为它仍是 reaction fallback evidence，不是要求的私聊/群聊 reply loop
   proof；private 路径按私聊会话视为 targeted。Group completion 必须证明两个
   不同 completed turn 和各自 internally consistent 的 gateway-normalized
   canonical `qq-group-[1-9][0-9]{4,11}` delivered-reply chain：一个触发 normalized chat row 为精确
   `mentions_bot=1`；
   另一个为回复已存 bot 消息且不含 mention 的入站 row，必须有 quote metadata、
   `mentions_bot=0`、非空 `reply_to_message_id`，并解析到同群、同会话、由独立
   `bot.response` raw event 支撑的 `bot-self` message。第二个 turn 的
   `action_decisions.reasons` 必须是包含精确 `reply_to_bot` 的 JSON array，successful
   action 还必须链接到另一个独立持久化的同群 bot response；quoted response、入站
   raw event、action execution、新 response 的 durable 时间必须依次不递减。每个
   turn 的触发 chat row、`context_traces` 和 bot-response chat row 都必须贯通该
   chain 的同一群 ID；精确 mention turn 不能同时充当 reply-to-bot proof。Required
   hints 还会统计 content-free 的 joint pair：两个 turn 必须不同、都使用 non-mock
   Pi identity，并且精确 mention action 的 `executed_message_id` 必须正是后续无 mention
   入站消息的 `reply_to_message_id`。两个 turn、context、inbound/outbound chain 必须在
   同一 normalized group/conversation 中且满足 durable 时间顺序。不同群里各自完整的
   chain，或同群但引用另一条旧 bot response，都不能满足该 joint hint。摘要仍只输出
   pair 计数和布尔 hint，不输出群 ID、message ID 或正文。

   Private targeted、group exact-mention 和 group reply-to-bot 三条 required flow
   都必须记录非空且不以 `mock`、`test`、`stub` 或 `fake` 开头的
   `agent_turns.pi_provider` / `pi_model`。此外至少一个 completed、delivered、
   non-mock acceptance turn 必须包含 `requested_by='pi'` 且 `status='success'`
   的 tool call；该 call 必须链接一个 `domain='tool'`、`decision='approve'`、
   non-prohibited 的 evaluator decision。该 decision 还必须反向链接恰好一个
   `purpose='evaluator'`、`status='completed'` 的 durable model invocation；
   invocation 与 decision 的 request/domain/turn、source 顺序、provider/model/prompt
   identity 和时间顺序必须精确一致。仅声明 non-placeholder evaluator version
   不能证明 Provider 调用。Tool 与 decision 还必须在 turn/tool/actor/context/trigger source
   上一致，同时存在 evaluator ID、
   actor/context 都匹配的 `tool.executed` audit。Evaluator request/decision、tool/audit、
   action execution、bot response 和 turn completion 的 durable timestamps 也必须按
   runtime 顺序成立。

   并且至少一个完整 acceptance flow 的 turn 通过自身
   `context_pack_id` 指向的 selected context 选择了 active、source/revision-linked、
   non-secret/prohibited governed memory。`candidate_memory_ids`、`selected_memory_ids`
   和 context `memories[].memoryId` 必须是有效 JSON、没有空值或重复值；selected 必须
   非空、全部来自 candidate，且与实际 context memories 完全一致。每一个 selected
   memory 都必须满足治理、可见性和 scope 检查；一条有效 memory 不能掩盖同一 context
   中另一条 prohibited、inactive、跨用户或 private-in-group selection。
   selected record 的 `created_at` 和按 revision number 选出的最新 governing revision
   都必须严格早于实际 context creation；revision 不能早于 record creation，
   `expires_at` 必须为空或严格晚于 context creation。该 flow 还必须满足
   turn start <= context creation <= action decision <= action execution <= turn completion。
   最新 revision 的 JSON
   snapshot 还必须与 record 的 ID、scope/owner/group/conversation、visibility、
   sensitivity、lifecycle state 和 source context 一致；脚本不会用旧 revision 掩盖未来或
   不一致的最新 revision。
   每条 selected memory 还必须至少有一个可用 durable source evidence row，该 source
   必须不同于当前 turn/trigger；source timestamp 及其 canonical durable chat/tool evidence
   都不能晚于 memory record creation 和 governing revision，并且必须早于当前 context。
   这样 same-turn 自引用或事后补挂 provenance 都不能冒充后续记忆召回。Memory 还必须对
   同一个 private/group flow context 可见并匹配同一 sender、group、conversation 或
   public/system 作用域；否则返回非零状态。对于
   `resolution_state='internal'` 的行，可用 provenance 只通过 source type 对应的
   canonical 列解析：`raw_event_id`、`chat_message_id`、successful
   `tool_call_id`，或 completed extraction `job_id` / `job_attempt_id` 二选一。
   worker source 只有在同一个 memory 还存在独立的 internal canonical raw/chat source
   行，并且 completed job payload/result 明确引用该证据时才计入。历史
   `legacy_unresolved` 行只使用受限的 `source_type` / `source_id` 兼容查找；
   `external` 行不能证明 inbound QQ evidence。解析后的 inbound raw/chat source
   必须贯通 inbound QQ `chat.message.received` raw event 与 inbound non-bot chat row，
   并兼容 selected memory 边界：user-scoped memory 的 chat source 必须来自同一
   canonical owner，group-scoped source 必须匹配 memory group/conversation，
   conversation-scoped source 必须匹配 memory conversation。orphan source ID、只有
   `user_command` source link、bot-response chat row、另一个用户的 chat/tool source、缺少兼容 chat/raw
   provenance 的 completed worker row，或 rejected/error tool-call row 不能满足 complete
   memory-governance DB hints。

   `counts.conservativeGroupDerivedUserMemories` 是另一个 aggregate-only 计数。它只统计
   `scope='user'`、具有 `group_chat`（或 `group_chat:` 前缀）source context、normalized
   `qq-group-<digits>` group、`same_group_only` visibility、非 secret/prohibited sensitivity，
   且未在摘要生成 cutoff 前过期的 source-linked record。`proposed` record 在最新 coherent
   revision 仍为 proposed 时可计入；`active` record 只有最新 coherent revision 的
   `change_type` 为 `approve` 或 `restore` 才计入。其 durable chat/tool provenance（以及
   worker 间接引用的 canonical chat provenance）必须来自同一 owner、同一 source group，
   不晚于 record creation/governing revision，并早于摘要 cutoff。群聊来源的 user memory 也只能在同一 normalized group 以
   `same_group_only` 被 selected；`same_user_any_context` / `public` 不会因 chat、tool 或
   worker provenance 而通过。

   `evidenceHints.conservativeGroupDerivedUserMemoryPresent` 仅表示上述计数大于零，
   `--require-acceptance-hints` 要求它为 true。摘要不会因此输出 memory ID、群 ID、owner、
   内容或 source payload。
   这些字段只能证明当前 runtime 写下的 Provider completion ledger 和 durable
   relational/temporal linkage；它不是远端 Provider 的密码学证明，也不能离线验证
   process-local `execution_binding` HMAC。实际网络调用仍由显式 opt-in real-provider
   test 和受控现场操作证明。该摘要只用于辅助填写 evidence，不替代真实私聊/群聊
   操作和最终 validators。

   如果需要分享或归档填写后的 evidence 文件，先运行本地离线检查：

   ```bash
   pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
   pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
   # 如果路径名本身可能敏感：
   pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
   pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
   ```

   Validator output intentionally reports a redacted path, status/count fields,
   and static finding line/rule/message fields without echoing matched values. A nearby `<redacted>` marker does not make a
   raw QQ/group/platform-like number safe; if a line still contains the raw
   identifier, the validator reports `platform-id-like-number`.

   该检查只报告脱敏路径、状态/计数和静态 finding 行号/规则/消息，不回显命中的原始值；CLI/DB-summary display 会整体隐藏 home/root 路径和 `/srv` 等非中性绝对路径，固定 `/tmp` 路径仍会继续执行 secret/platform marker 脱敏。若发现 secret-like token、password/passwd/pwd/recovery assignment、私钥/JWT、未脱敏 QQ/群号长数字、raw CQ tag、或 `raw message text:` 等未脱敏正文，会以非零状态退出。`<redacted>`、`hash` 或 `internal-id` 只有在整个字段值符合封闭 placeholder 格式时才算脱敏，不能作为 raw value 的前缀或子串来绕过检查。

   默认 validator 只执行启发式 redaction 扫描；空模板和无法由静态规则识别的
   free-form 文本都可能通过，因此它不独立证明文件适合分享。分享前仍须人工确认
   没有正文、昵称、平台标识或其他私密内容。
   完成真实本地验收记录后，再加 `--require-complete`；该模式要求文件保持生成模板
   的精确结构，拒绝追加或改写的未知行，并要求 R0-R8 / `TARGET_COMPLETE` 矩阵中
   每个 `REL-*` 场景和 direct delivered-reply p95（不高于 15000 ms）都有勾选证据。
   每个矩阵场景还必须保留生成的 scenario ID、fixed verification command 和 required
   behavior，并填写 expected/actual classification、checks passed/total、durable-chain
   evidence 与 scenario result；完成态只接受 actual/result 为 pass、相等且大于零的
   passed/total，以及 verified durable chain。模板其他占位字段也使用封闭格式：
   状态/动作是枚举，计数和延迟是数字，operator 和复现摘要必须是
   internal/redacted 标签，日期/生成时间必须是真实可往返解析的 ISO calendar value。
   DB 路径只能是 `internal-db-path`、显式 redacted marker、
   `/tmp/lethebot-acceptance.db` 或 `./data/lethebot/acceptance.db`；纯数字 internal ID
   和任意 basename 不能通过 complete validation。
   该模式还拒绝 checked
   `mock` provider 和固定 mock 的 `docker-compose.local-acceptance.yml`，并要求核心
   command preflight、worker-soak aggregate output、health、OneBot、私聊、
   群聊精确 @bot、同群无 mention 的 reply-to-bot、memory/privacy、FK、
   evidence validator 自检结果和最终
   accepted checklist 已勾选，并拒绝已勾选项目中的占位值、
   `failed` / `rejected` / `degraded` / `not_ready` 等失败状态，或
   “accepted / not accepted”同时勾选的冲突决策。完整验收还必须在
   `Compose file`、`Pi provider`、`OneBot transport` 三组选项里各且只勾选
   一个实际运行配置；provider 选项必须是显式 credential injection 的 real provider。
   完整验收还必须勾选 DB summary 已证明三条 required flow 的 non-placeholder
   Pi identity、同群 exact-mention response 被后续 no-mention reply 精确引用的 joint
   pair，以及至少一个 evaluator-reviewed successful Pi tool execution。
   完整验收必须记录
   两个 compose 文件的 `config --quiet` 预检通过、`pnpm ops:worker-soak`
   以 aggregate-only 输出退出 0、acceptance DB 的 `foreign_key_check`
   无行、`/healthz` 为健康、`/readyz` 为 ready、私聊 turn 以及两个不同的
   同群 mention/reply-to-bot turn 都为 completed、各自 action execution 为 success。
   memory/privacy 证据也必须包含受治理记忆影响的允许回答、群聊来源记忆
   保守且 source-linked、生命周期/敏感度排除即时生效，以及治理 CLI 脱敏
   检查；不能只凭收发消息成功就把验收标记为完成。

   `--require-complete` 只解析生成模板结构、Markdown 勾选项、结构化场景状态/计数、
   固定 verification command、选项组合、latency aggregate 和占位值；它
   不执行记录的命令，不读取或与 acceptance DB 交叉绑定，不联系 provider、
   OneBot 或 QQ，不认证操作者的勾选声明，也不能验证 process-local
   `execution_binding` HMAC。必须单独实际运行命令、生成 DB summary，并由
   操作者核对这些证据。
   旧版本生成的模板不满足这个结构契约；开始一次新的完成态验收时应重新生成模板，
   而不是在旧模板末尾追加缺失场景。

   `local-acceptance-evidence` CLI 会显式拒绝格式错误的参数：`--out` / `--out=` 和 `--validate` / `--validate=` 缺少文件路径时失败，未知 option 会失败，模板模式下裸 positional 参数也会失败；`--validate` 与 `--summarize-db` 等冲突 mode 也会在读取 evidence/DB 前失败。生成模板可使用 `--out=/tmp/lethebot-acceptance-evidence.md` 或 `--out /tmp/lethebot-acceptance-evidence.md`；脚本自身输出的 parser error 会先做 redaction。模板中的两条 Compose 语法预检固定带 `--env-file /dev/null`，避免纯离线预检读取项目 `.env`。

   记录 HTTP header 证据时，请写 `Authorization: Bearer <redacted-token>` 这类已脱敏占位值。validator 会接受明确 redacted 的 bearer 值，但 raw bearer token / API-key-like 值仍会被判定为 finding，且不会回显原始 token。嵌在 legacy identifier 中、位于非字母数字分隔符后的 `sk-...` 片段（例如 `_sk-...`）同样会被判定为 API-key-like finding；嵌在 legacy identifier 中、位于非字母数字分隔符后的 8–12 位 QQ/群号/平台号数字（例如 `_12345678901`）也会被判定为 platform-ID finding，并在 CLI 路径/错误输出中脱敏。CLI display redaction 也会处理 legacy/free-text 中的 prefixed platform identifiers，例如 `legacy_qq-...`，避免留下 `legacy_qq-` 这类部分脱敏残留。相邻 secret/platform 片段（例如 `sk-...-qq-...`）会按 platform-before-secret-after-platform 的显示顺序脱敏，确保输出同时保留 secret 和 platform 两类 redaction markers，但不暴露原始值。

   建议记录：

   - 日期、compose 文件、镜像/源码版本；
   - `curl http://localhost:6700/healthz` 的 redacted 结果；
   - `pnpm verify:onebot` 结果；
   - 私聊一条、同群精确 @bot 一条、以及回复该 bot response 且无 mention 的另一条消息，各自 `raw_events` / `chat_messages` / `agent_turns` / `action_executions` 行数或只含内部 ID 的截图；
   - 至少一个上述 accepted turn 中由 Pi 请求、经 completed durable Provider invocation 支撑的 model evaluator approve 并成功执行的 tool call，只记录 aggregate hint/计数；
   - `PRAGMA foreign_key_check;` 结果；
   - default validator 和 `--require-complete` validator 对同一 evidence 文件的 redacted 通过结果；
   - 不记录真实 QQ 号、群号、API key、token、私聊正文或群聊原文。

## 常见问题

### `lethebot` 一直 degraded

优先看：

```bash
docker compose -f docker-compose.snowluma-framework.yml logs -f lethebot snowluma
# 源码构建栈改用 docker-compose.local-acceptance.yml
curl http://localhost:6700/healthz
```

常见原因：

- SnowLuma 尚无账号会话，OneBot WS server 未监听。
- `ONEBOT_TOKEN` 与 SnowLuma `config/onebot.json` 中的 `accessToken` 不一致。
- `LETHEBOT_BOT_QQ_ID` 未设置或设置错，群聊 @bot 判断不准确。

### 源码构建栈改了 SnowLuma OneBot token 后连接不上

保持这三处一致：

- shell / `.env` 中的 `ONEBOT_TOKEN`
- `./data/snowluma-config/onebot.json` 的 `accessToken`
- `lethebot` 容器环境里的 `ONEBOT_TOKEN`

可用下面命令整份重写 SnowLuma 本地验收配置；它不是 token-only 修改，现有
`onebot.json` 自定义会被 seed 替换：

```bash
SNOWLUMA_ACCEPTANCE_OVERWRITE_ONEBOT_CONFIG=1 \
ONEBOT_TOKEN=lethebot-local-token \
docker compose -f docker-compose.local-acceptance.yml up -d snowluma lethebot
```

### 源码构建栈的 SnowLuma 镜像构建慢或失败

本 compose 从 `../SnowLuma` 源码构建 SnowLuma。首次构建需要安装依赖并执行 `pnpm build:all`。

如果失败，先在 SnowLuma 仓库确认源码能独立构建：

```bash
cd ../SnowLuma
corepack enable
pnpm install --frozen-lockfile
pnpm build:all
```

也可以把 `snowluma` service 改成官方或本地预构建镜像，只保留相同端口、volume 和 `ONEBOT_TOKEN` 配置。
