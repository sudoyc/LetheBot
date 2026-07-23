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

LetheBot does not load `.env` implicitly. The deterministic checks above do not
need it; pass the file explicitly only when starting a configured local runtime.

## 生产 / 受控试运行配置

创建 `.env` 文件并配置以下变量。变量名应和当前 `src/config/index.ts` / `src/index.ts` 保持一致。应用本身不会自动读取该文件；由 systemd、Docker Compose 或显式的 `node --env-file=.env` 启动参数注入。

```bash
# 基础配置
NODE_ENV=production
LOG_LEVEL=info
LETHEBOT_TEST=false
# Sends retained conversation text to the configured Pi Provider when enabled.
LETHEBOT_BACKGROUND_SUMMARY_ENABLED=false

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
PI_TURN_TIMEOUT_MS=120000

# Structured evaluator for social decisions and evaluator-required Pi tools.
# Provider/model/base/key inherit the complete Pi identity when both identity
# overrides are omitted. A separate identity requires both fields and its key.
EVALUATOR_TIMEOUT_MS=30000
EVALUATOR_MAX_RETRIES=1
EVALUATOR_TEMPERATURE=0
EVALUATOR_PROMPT_VERSION=lethebot-governance-v1
# EVALUATOR_PROVIDER=openai
# EVALUATOR_MODEL=deepseek-chat
# EVALUATOR_BASE_URL=https://api.deepseek.com/v1
# EVALUATOR_API_KEY=your_separate_evaluator_key

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

生产环境首次启动前创建数据目录。当前应用启动时会先验证完整的
`001 -> 002 -> 003 -> 004 -> 005` 连续迁移集合，再自动迁移：

```bash
mkdir -p ./data
```

`001` creates an empty `schema_version` ledger. On first application startup,
the runner applies v1 compatibility work, the v2 evaluator-owner migration, the
v3 evaluator Provider-invocation migration, the v4 correction-attempt migration,
and the v5 delayed-Attention migration. It validates each migration-derived
structure and foreign-key data and records ledger rows `[1,2,3,4,5]` in the same
transaction. Existing legacy databases with no ledger and v1-v4 databases are
adopted only when their LetheBot-owned objects can be migrated to that contract;
an incompatible same-name table/index/trigger or FK violation rolls the
transaction back. A malformed ledger or a valid version above 5 is rejected
before migration schema/data writes; do not edit the ledger by hand to bypass
that guard.
Known early-v1 memory CHECK constraints are rebuilt transactionally to the
current v1 definitions while preserving rowids, linked rows, indexes, triggers,
and FTS linkage; unknown constraint drift still fails closed, and the runner
restores per-connection FK enforcement after the rebuild before startup
continues. Rebuild eligibility compares the complete normalized legacy table
definition, so additional UNIQUE/STRICT/COLLATE/conflict/deferrable semantics
are not silently erased. If the external-content `memory_fts` table was absent,
startup recreates and rebuilds it from existing memory rows in the same
transaction.
This runtime targets v5 and can activate against a v1, v2, v3, v4, or v5 shared
database, so release preflight requires target 5 with readable range 1 through
5. Widening only the package manifest or omitting any required migration is
rejected. Migration `005_delayed_attention.sql` adds the source-bound
`attention_candidates`, `attention_decisions`, and `attention_suppressors`
contract used by `attention_recheck` jobs; take and retain a verified backup
before activating the first v5 release.

## 启动服务

```bash
pnpm build
NODE_ENV=production node --env-file=.env dist/index.js
```

健康检查：

```bash
curl http://localhost:6700/healthz
```

健康响应会覆盖：

- `checks.database.ok/open`
- `checks.adapter.ready`
- adapter token/bot-id 是否已配置（不回显 token 值）

## 本地双容器协议 / Mock 验收

源码构建栈固定使用 mock Pi，适合协议对接和 deterministic 本地调试：

```bash
docker compose -f docker-compose.local-acceptance.yml up -d --build
```

详细步骤见 [`docs/local-container-acceptance.md`](./local-container-acceptance.md)。
真实 provider 与完整 QQ 验收必须改用该文档中的 SnowLuma Framework 栈，
显式注入非 mock provider/model/credential；固定 mock 栈会被
`--require-complete` 拒绝。

Framework 的完整启动/重建会挂载、消费并可能改写持久化的 QQ / SnowLuma
会话与配置，必须另有明确授权；启动或重建 LetheBot、使用模型凭据并不包含这项
权限。强制 OneBot reset 会整份重写 `onebot.json`，而不是只替换 token；强制
WebUI reset 会删除并重新生成整份 WebUI auth 配置。未获授权时只用
`--no-deps` 操作 `lethebot` service，不要启动或重建 `snowluma`。具体影响和命令
见上述验收文档。

## 部署脚本

当前脚本只生成部署资产，不自动构建镜像或启动服务。用
`--output-dir` 指定 Docker Compose、systemd 和 PM2 资产目录；configure
模式可用 `--config-path` 指定配置模板路径，未指定时写入输出目录下的
`.env`。systemd 和 PM2 还要求显式的绝对 `--deployment-root`，资产中的
代码路径固定指向 `<root>/current`，运行配置、数据库和日志固定放在
`<root>/shared`。managed mode 的输出目录必须恰好是 `<root>/shared`；脚本
拒绝生成引用一个 root、却把 gate 写到另一个目录的自相矛盾配置。

```bash
pnpm deploy:configure --output-dir=/tmp/lethebot-deploy
pnpm deploy:configure --config-path=/tmp/lethebot-deploy/runtime.env
pnpm deploy:docker --output-dir=/tmp/lethebot-deploy
pnpm deploy:systemd --deployment-root=/srv/lethebot --output-dir=/srv/lethebot/shared
pnpm deploy:pm2 --deployment-root=/srv/lethebot --output-dir=/srv/lethebot/shared
```

The managed host layout is:

```text
/srv/lethebot/
  releases/<release-id>/{dist,migrations,node_modules,package.json,pnpm-lock.yaml}
  current -> releases/<release-id>
  previous -> releases/<prior-id>
  .activation-state.json       # pending activation/rollback/confirmation journal
  .release-rollback/           # private operation-owned SQLite snapshot
  shared/bin/{managed-startup.js,release-artifact.js,manifest.json,package.json}
  shared/ecosystem.config.cjs  # PM2 only
  shared/runtime.env
  shared/data/lethebot.db
  shared/logs/
```

Create `releases`, `shared/data`, and `shared/logs` before the first activation,
and install the reviewed environment as `shared/runtime.env` with restrictive
permissions. A one-time move from an older checkout-local `.env` or SQLite path
must be done as a separate stopped-service maintenance operation. Take a
verified backup first and do not move a live database or leave its WAL/SHM
sidecars behind. During a managed activation, the controller creates its own
private verified pre-upgrade SQLite snapshot after the prior service stops; that
operation snapshot is separate from the retained operator backup described
below.

The generated systemd unit runs as the fixed `lethebot` account. Install the
managed root, releases (including each release-local `node_modules`), stable gate
bundle, manifest, unit, and runtime configuration as root-owned and not
group/world writable; grant `lethebot` read/execute access to those paths plus
read/write access to `shared/data` and `shared/logs`. Release digest calculation
also requires every release artifact and dependency entry to share the release
root owner and rejects group/world-writable entries. Keep `runtime.env` to the
conservative `KEY=value` subset accepted by both systemd and Node's dotenv
parser.
On POSIX, every writable `initDatabase()` start creates or remediates the real
database file and any existing WAL/SHM sidecars to mode `0600`, including when
the configured path is a symlink. This is a file-mode boundary, not an ownership
or directory substitute: keep `shared/data` private and owned by the service
account. Readonly maintenance opens do not create files or change modes. Windows
deployments must apply equivalent directory/file ACLs.

The checked-in multi-stage Dockerfile copies only package metadata, TypeScript
configuration, `src`, and migrations into its build stage; the runtime stage
contains production dependencies, `dist`, and migrations. It frozen-installs,
builds, and runs the offline release preflight. The runtime starts under
`umask 077`; the application-level `0600` enforcement is an additional boundary
for SQLite database, WAL, and SHM files. The image runs as the built-in `node`
account (`1000:1000`) rather than root. Checked and generated Compose files map
that identity through `LETHEBOT_UID` / `LETHEBOT_GID` and refuse to silently
create a missing root-owned bind directory. Pre-create the directory with the
selected owner before startup:

```bash
export LETHEBOT_UID="$(id -u)"
export LETHEBOT_GID="$(id -g)"
install -d -m 700 /tmp/lethebot-deploy/data/lethebot
```

If an older root-running container already created a database, stop LetheBot
and change ownership of only its main DB and existing `-wal` / `-shm` sidecars,
regardless of their current mode, before switching identities. Do not make the files group/world
readable and do not recursively change a directory shared with SnowLuma.
Generated Compose mounts only `./data/lethebot`; an existing generated-stack
database at `./data/lethebot.db` must be moved, while stopped, to
`./data/lethebot/lethebot.db` together with any WAL/SHM sidecars. Follow the
conflict checks, verified backup, exact-file move, verification, and rollback
procedure in [Local Container Acceptance](local-container-acceptance.md#from-old-parent-bind-to-dedicated-lethebot-bind),
substituting those two paths. Starting against an empty destination before that
move can create a new empty database that looks like data loss.

Tag the image with a reviewed revision or immutable registry digest, then
supply it when starting the generated Compose file:

```bash
docker build -t lethebot:<reviewed-revision> .
LETHEBOT_IMAGE=lethebot:<reviewed-revision> \
LETHEBOT_UID="$(id -u)" \
LETHEBOT_GID="$(id -g)" \
  docker compose -f /tmp/lethebot-deploy/docker-compose.yml up -d
```

Generated Compose never bind-mounts the source checkout and never installs or
builds packages at container startup. It fails interpolation when
`LETHEBOT_IMAGE` is absent, but it cannot reject a mutable value such as
`:latest`; use a registry digest when cryptographic image immutability is
required. Its explicit runtime contract defaults Pi/model to `mock`, keeps
background summaries off, forwards optional evaluator overrides without
inventing empty values, and uses a Node-based status-aware healthcheck available
in the reviewed image. Edit the local runtime configuration before selecting a
real provider. The generated PM2 artifact is
`ecosystem.config.cjs`, so its `module.exports` contract remains loadable under
this repository's ESM package mode. It parses
`<deployment-root>/shared/runtime.env`, then forces the shared database path;
generate or install it as `<deployment-root>/shared/ecosystem.config.cjs`.
Before PM2 receives the environment, the generated config deletes
`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, and `LD_AUDIT`.
PM2 activation and recovery reject a missing/symlinked/misbound ecosystem file
before taking the release lock. Updates delete the old PM2 process record before
starting the reviewed ecosystem again, so variables removed from `runtime.env`
do not survive a reload.

Both managers use the release-external protocol-3 gate in `shared/bin`. Its
manifest binds the protocol and SHA-256 of `managed-startup.js` and
`release-artifact.js`; the controller rejects an old or modified bundle before
downtime. Systemd runs that gate as a root `ExecCondition`, unsets the same
dangerous environment variables, then starts the release as `lethebot`. PM2 runs
the stable gate in `launch` mode and treats exit 78 as a non-restartable denial.
The controller verifies the installed systemd directives or PM2 root,
entrypoint, launch mode, database path, and stop code before lifecycle work.

While a journal exists, startup requires a one-use permit bound to the canonical
root, operation ID, release ID, and release digest. The gate atomically renames
it to `.startup-authorization.claimed`; the controller removes the claim only
after health succeeds, so an automatic restart cannot reuse it. This lets an old
release with no in-release hook participate in a new rollback protocol. The
systemd gate/`ExecStart` boundary still contains a check-to-exec interval, so the
root-owned immutable release rule is part of the security boundary. PM2 is
weaker: its controller, daemon, and release normally share one UID, so that UID
can still race its own checks. Use systemd for the stronger production boundary.

After a reviewed release has passed `pnpm release:check` inside the direct
`releases/<release-id>` directory, exercise and run the managed activation:

```bash
pnpm --silent ops:rehearse-application-rollback
pnpm --silent ops:activate-release -- \
  --root=/srv/lethebot \
  --release=<release-id> \
  --manager=systemd
```

The rehearsal consumes that existing build, copies it into A/B release slots,
and runs real `node current/dist/index.js` processes against disposable shared
SQLite with mock Pi and loopback-isolated HTTP OneBot. Its aggregate result
requires real health/readiness, empty-ledger v5 adoption/idempotency, readiness-triggered
rollback to A, preserved DB sentinel/version timestamps, a stable logical
fingerprint of all non-internal schema objects and table rows after A readiness,
clean integrity/FKs, and complete process/workspace cleanup. It performs no Provider
or QQ call. Both slots deliberately contain the same reviewed build, so this is
a lifecycle/rollback-mechanics rehearsal, not cross-version compatibility
proof. Each temporary release has a release-local `node_modules` link to one
disposable-root dependency tree, so the dependency digest is exercised without
copying the 228 MB development tree twice. Before a real version change, retain
the prior release and separately
exercise candidate start and prior-release restart on a disposable copy of
production-shaped data.

For that cross-version proof, pass two distinct immutable managed release
directories. The command creates three disposable roots and prints one aggregate
JSON line without input paths or DB content:

```bash
pnpm --silent ops:rehearse-cross-version -- \
  --prior-release=/srv/lethebot/releases/<v4-release> \
  --candidate-release=/srv/lethebot/releases/<v5-release>
```

It requires three independent outcomes: readiness failure restores the exact v4
DB/pointers and starts/probes v4; an unconfirmed v5 crash is denied by the stable
gate and explicit recovery restores v4; a wrong confirmation preserves the
recovery point while exact confirmation removes it and permits a marker-free v5
restart. The rehearsal checks the v4/v5 ledgers, absence/presence of the v5
delayed-Attention tables, DB mode/UID/GID, sentinel/integrity/FKs, and operation
cleanup. Never point it at a live managed root or mutable release directory.

Use `--manager=pm2` for the PM2 artifact. The command must run with authority to
control the selected service manager. It validates the candidate, release-local
dependencies, gate bundle, and manager binding before downtime, then takes a
bounded `.activation.lock`. If a valid pending `.activation-state.json` exists,
activation reconciles it under that lock before considering another candidate.
On a clean activation it checks the shared DB read-only against the candidate's
validated `lethebotSchema` range; malformed or incompatible metadata exits
`schema-incompatible` before intent, service stop, snapshot, or pointer changes.

The current writer uses journal `schemaVersion: 2`; schema v1 is accepted only as
a legacy pointer-only recovery input. Exact v2 keys are `schemaVersion`,
`operationId`, `operationKind`, `phase`, `candidateReleaseId`,
`candidateDigest`, `originalReleaseDigest`, `originalPointers`,
`targetPointers`, and `rollbackSnapshot`. Phases are `intent_recorded`,
`snapshot_ready`, `awaiting_confirmation`, `confirming`, and
`rollback_completed`. The two release digests cover `dist`, migrations,
package/lock metadata, and a deterministic metadata/link-target fingerprint of
release-local `node_modules`; they also enforce one owner and safe permissions.
The fixed `.activation-state.tmp` is synced before rename, and extra fields or
invalid phase transitions fail closed.

After persisting `intent_recorded`, activation stops the prior application. It
then creates `.release-rollback/<operation-id>.db` with SQLite's backup API,
checks integrity and foreign keys, records its SHA-256/schema plus the original
database mode/UID/GID, fsyncs it, and persists `snapshot_ready` before publishing
either pointer. If the database did not exist, the journal records that fact
instead of inventing a snapshot. Only then does it publish the relative
`previous`/`current` links, issue a one-use startup permit, start the candidate,
and check health then readiness. A healthy candidate advances to
`awaiting_confirmation`; the journal and rollback snapshot deliberately remain.

Confirm the exact release and operation ID returned by activation:

```bash
pnpm --silent ops:confirm-release -- \
  --root=/srv/lethebot \
  --release=<release-id> \
  --operation-id=<operation-id> \
  --manager=systemd
```

Confirmation rechecks pointers, candidate/dependency digest, schema readability,
snapshot, health, and readiness before entering `confirming` and deleting the
snapshot/journal. If the host stops in `confirming`, repeat the same confirmation
command: it restarts the candidate through the one-use gate, probes it, and then
finishes cleanup. Another activation cannot silently confirm or replace an
`awaiting_confirmation` release.

Candidate start or probe failure stops the candidate, validates the original
release digest, restores the pre-upgrade SQLite snapshot before restoring
pointers or starting old code, then restarts/rechecks the original current
release when one existed. If the original DB was absent, rollback removes the
candidate-created DB. Main DB WAL/SHM/journal and operation restore scratch files
are reconciled under the stopped-service boundary. A successful restoration
reports `activation-failed`; an incomplete stop, DB restore, pointer restore,
restart, probe, or cleanup reports `rollback-failed` and retains the journal for
retry. `rollback_completed` recovery restarts/probes the original release before
claiming success and removing state.

Run explicit recovery with the same service manager:

```bash
pnpm --silent ops:recover-release -- \
  --root=/srv/lethebot \
  --manager=systemd
```

With no journal, recovery performs no lifecycle call and reports
`recovered: false`. With a valid journal, it stops the managed service, clears
only operation-owned startup state, restores the recorded DB state, restores the
exact pointer pair, starts/probes the original release, then records
`rollback_completed` and cleans up. Explicit recovery of
`awaiting_confirmation` therefore means rollback; use `ops:confirm-release` to
accept it. Malformed journal, foreign temp/snapshot/permit state, changed release
digest, or an unexplained pointer pair fails closed. Recovery runs through this
command or at the start of a later activation; the stable supervisor gate is the
host-start fail-closed hook while a journal exists.

The rollback snapshot is private operation state, not the retained external
backup. It restores POSIX mode/UID/GID, but not extended ACLs or xattrs; operators
using those controls must capture and reapply them separately. A confirmed
release has no persistent digest file, so post-confirmation integrity still
depends on the immutable ownership/permissions policy.

New lock candidates use
`.activation-lock-v2.<nonce>.<pid>.<base64url-process-identity>.tmp`. A live
owner's empty or partial write is preserved and does not prevent contenders from
reaching the atomic hard-link race; a dead/PID-reused owner is removed only when
the bytes are a stable prefix of its exact metadata. A partial legacy
`.activation-lock-<uuid>.tmp`, malformed candidate, or old directory-valued
`.activation.lock` cannot prove ownership and requires manual reconciliation.
Never remove one until no activation/recovery/confirmation process is running.
If owned lock cleanup fails, the command reports `cleanup-failed`.

Do not prune or replace a release named by a pending journal. Individual link
renames are atomic but the pointer pair is not; recovery accepts only the
recorded original/target and journal-explained intermediate pairs. The operation
rollback snapshot automatically reverses candidate DB writes/schema during this
window, while the separately retained operator backup remains the disaster
recovery path after confirmation.

For a managed-root OneBot check, load the reviewed environment explicitly from
a clean process instead of relying on the operator shell:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  node --env-file=/srv/lethebot/shared/runtime.env \
  /srv/lethebot/current/dist/scripts/verify-napcat.js
```

Use neutral output/config paths. If an argument could contain a credential,
private identifier, or private username, rename it first and invoke the package
script with `pnpm --silent` so package-manager argument echo cannot precede the
script's redaction boundary.

`pnpm verify:onebot` 会按 `ONEBOT_TRANSPORT` 检查当前 OneBot 运行时；`pnpm verify:napcat` 是兼容别名。

## 治理命令

使用 CLI 管理记忆和审计：

```bash
pnpm cli list-memory
pnpm cli list-memory --user user-alice
pnpm cli disable-memory <memory-id>
pnpm cli delete-memory <memory-id>
pnpm cli why --turn <turn-id>
pnpm cli redact-display-profile <canonical-user-id>
```

## Fake-to-real parity checklist

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

Use the tested online SQLite backup command. It verifies the resulting backup
before reporting success and does not require stopping the application:

```bash
mkdir -p ./backups
pnpm ops:backup -- \
  --db=./data/lethebot.db \
  --out=./backups/lethebot-$(date +%Y%m%d-%H%M%S).db
```

Successful POSIX backup output is forced to `0600` before the command reports
success. Backup publication never replaces an existing destination entry; use a
new output name for every run and retain prior recovery points. Keep the backup
directory private; on Windows, configure an equivalent
restrictive ACL because Unix mode bits are not a complete ACL boundary.

External restore remains a separate stopped-service disaster-recovery
operation. Follow the validated `ops:restore` procedure in
[Operations](operations.md). During an unconfirmed managed activation, ordinary
release rollback instead uses its private operation snapshot automatically;
confirmation deletes that snapshot but does not delete the retained external
backup.

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
- `PI_API_KEY` 已通过进程环境显式设置；缺失时非 mock runtime 会拒绝启动

### Evaluator 未生成 Provider invocation

生产 social/tool/memory evaluator 只有在 `LETHEBOT_TEST=false` 且解析后的 evaluator
provider 不是 `mock` 时才使用结构化模型客户端。若未设置
`EVALUATOR_PROVIDER` / `EVALUATOR_MODEL`，它继承完整的 Pi provider/model/base/key
配置。若要覆盖 evaluator identity，必须同时设置两个字段；该路径不会继承
Pi endpoint 或 key，还必须显式设置 `EVALUATOR_API_KEY`。缺失凭据会在启动时
失败，不会退回 stub。非 mock evaluator 还要求当前 schema v6 中的 durable
invocation ledger；启动时应用会注入当前数据库 repository。每次调用应留下
一个或在严格结构纠正时两个 `completed`、`failed` 或 `aborted` invocation，成功决策应通过
`evaluator_decisions.model_invocation_id` 唯一链接它。`LETHEBOT_TEST=true` 或
provider=`mock` 会按设计使用 rule-driven stub，因此不会生成 invocation。

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
