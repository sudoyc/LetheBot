# Operations

The first deployment target is one local machine or small VPS running one Node process, one SQLite database, one bot account, and one QQ group.

## Runtime Processes

Recommended MVP processes:

- `gateway`: SnowLuma / OneBot WS or HTTP event receiving and message routing.
- `api`: internal HTTP server and governance CLI entrypoints.
- `worker`: summarization, extraction, retention, backup, and maintenance jobs.
- `pi-runtime`: embedded in API at first; split later only if needed.

For MVP these can be one Node process with module boundaries preserved in code.

## Configuration

Use environment variables for secrets and deployment-specific values:

- `LETHEBOT_DB_PATH`
- `LETHEBOT_RAW_EVENT_RETENTION_DAYS`
- `LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS`
- `LETHEBOT_AUDIT_LOG_RETENTION_DAYS`
- `LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS`
- `ONEBOT_TRANSPORT`
- `ONEBOT_WS_URL`
- `ONEBOT_HTTP_URL`
- `ONEBOT_TOKEN`
- `LETHEBOT_BOT_QQ_ID`
- `LETHEBOT_PORT`
- `LETHEBOT_HOST`
- `LETHEBOT_HEALTH_PATH`
- `LETHEBOT_EVENT_PATH`
- `PI_PROVIDER`
- `PI_MODEL`
- `PI_BASE_URL`
- `PI_API_KEY`

Do not commit `.env` files, logs, SQLite databases, API keys, or private QQ identifiers.

## Health and Readiness

Run:

```bash
curl http://localhost:6700/healthz
```

Expected healthy response fields:

- `status: "ok"`
- `checks.database.ok: true`
- `checks.database.open: true`
- `checks.adapter.ready: true`
- `checks.adapter.hasToken: true | false`
- `checks.adapter.botIdConfigured: true | false`

Known failure modes:

| Symptom | Likely cause | Operator action |
|---|---|---|
| `/healthz` returns 503 / `database.ok=false` | DB missing, locked, corrupt, or wrong `LETHEBOT_DB_PATH` | Check path, file permissions, `PRAGMA integrity_check`, restore from backup if corrupt. |
| `/healthz` returns `adapter.ready=false` | app not fully started, adapter stopped, or WS transport disconnected | Check process logs, SnowLuma status, `ONEBOT_TRANSPORT`, and restart service if needed. |
| OneBot event POST returns 401 | `ONEBOT_TOKEN` mismatch or SnowLuma reverse HTTP signature/Bearer mismatch | Align token in SnowLuma and `.env`; retry with Bearer or verify SnowLuma `X-Signature`. |
| Group @bot does not trigger | missing/wrong `LETHEBOT_BOT_QQ_ID` | Set bot QQ id to the actual bot account and restart. |
| `pnpm verify:onebot` fails | SnowLuma / OneBot down, wrong transport/URL/token, network issue | Check `ONEBOT_TRANSPORT`, `ONEBOT_WS_URL`, `ONEBOT_HTTP_URL`, token, and SnowLuma process. |
| FK/check failures after maintenance | manual DB edits or unsafe deletion | Stop service, restore from latest verified backup, rerun tests on a copy. |

## Backup and Restore

Use the tested maintenance script for online SQLite backup and integrity-checked restore.

```bash
# Backup current configured DB
pnpm ops:backup -- --db=./data/lethebot.db --out=./backups/lethebot-$(date +%Y%m%d-%H%M%S).db

# Restore to a new path first
pnpm ops:restore -- --backup=./backups/lethebot-20260702-120000.db --db=./data/restore-check.db

# Replace production DB only after checking the restore
pnpm ops:restore -- --backup=./backups/lethebot-20260702-120000.db --db=./data/lethebot.db --overwrite
```

Restore procedure:

1. Stop LetheBot.
2. Copy current DB aside if it exists.
3. Restore backup to a temporary path.
4. Run `sqlite3 <restored.db> "PRAGMA integrity_check;"` and a small read-only smoke check.
5. Restore with `--overwrite` only after the temporary restore is verified.
6. Start LetheBot and check `/healthz`.

Keep off-machine backups encrypted if they leave the host.

## Retention Policy

Retention is explicit and operator-run in R9. `0` means keep forever. The script deletes in FK-safe order and purges only `disabled` / `deleted` memories, never active memory.

```bash
pnpm ops:retention -- \
  --db=./data/lethebot.db \
  --raw-days=30 \
  --chat-days=90 \
  --audit-days=90 \
  --memory-days=365
```

If CLI flags are omitted, the script uses:

- `LETHEBOT_RAW_EVENT_RETENTION_DAYS`
- `LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS`
- `LETHEBOT_AUDIT_LOG_RETENTION_DAYS`
- `LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS`

Retention behavior:

- `chat_messages`: delete rows with `timestamp < cutoff`.
- `raw_events`: delete rows with `timestamp < cutoff` only after dependent chat rows are gone and excluding events still referenced by `agent_turns`.
- `audit_log`: delete rows with `timestamp < cutoff`.
- `memory_records`: hard-purge only `state IN ('disabled', 'deleted')` with `updated_at < cutoff`, plus `memory_sources` and `memory_revisions`; rebuild `memory_fts` after purge.

Run backup before retention.

## Metrics and Logging

Get a JSON metrics snapshot:

```bash
pnpm ops:metrics -- --db=./data/lethebot.db
pnpm ops:metrics -- --db=./data/lethebot.db --since=2026-07-01T00:00:00Z
```

Metrics fields:

- `rawEvents.total`
- `chatMessages.total`
- `agentTurns.total`
- `agentTurns.byStatus`
- `agentTurns.tokensTotal`
- `memoryWrites.total`
- `memoryWrites.byState`
- `policyAuditEvents.total`
- `policyAuditEvents.byCategory`
- `policyAuditEvents.byRiskLevel`
- `policyAuditEvents.byEventType`
- `toolCalls.total`
- `toolCalls.byStatus`
- `toolCalls.secretsRedacted`

Structured logs should include these operational identifiers when available:

- `conversationId`
- `messageId`
- `eventId`
- `turnId`
- `contextPackId`
- `selectedMemoryIds`
- `toolCallIds`
- `workerJobId`
- `policyDecisionId` / audit event id
- `eventProcessingFailures[]`

Do not log credential values. If a tool output may contain secrets, logs/audit must use redacted summaries.

## Failure Runbook

### Event processing failures

1. Check logs for `Failed to handle event` and app `getEventProcessingFailures()` in tests/debug.
2. Confirm `raw_events` has or does not have the event.
3. Run `PRAGMA foreign_key_check;` on a DB copy.
4. Reproduce with `tests/integration/e2e-conversation.test.ts` or a temporary fake event.

### Memory retrieval leak or stale memory

1. Use `pnpm cli why <turn-id>` to inspect selected/rejected memory IDs.
2. Use `pnpm cli list-memory --state active --user <id>` or group/conversation filters.
3. Disable/delete suspect memory through governance CLI.
4. Re-run retrieval test or context explanation before re-enabling.

### Tool/policy incident

1. Query `audit_log` by event type/category and `tool_calls` by turn id.
2. Confirm `secrets_redacted=1` when secret-like output was involved.
3. Disable the tool or tighten registry policy before replaying the turn.

### Database corruption or accidental deletion

1. Stop LetheBot.
2. Copy current DB, WAL, and SHM files aside for analysis.
3. Restore the latest verified backup to a temporary path.
4. Run integrity and FK checks.
5. Replace production DB only after verification.

## Dependency Update Policy

- Treat dependency and lockfile changes as reviewed code.
- Update one dependency group at a time.
- Before update: run `pnpm typecheck && pnpm lint && pnpm test:run` and record baseline.
- After update: run the same gates plus relevant real-provider/live checks only if explicitly configured.
- Do not update Pi SDK, SQLite, or tool/sandbox dependencies together unless the change is specifically a compatibility migration.
- Never commit generated secrets, `.env`, logs, DB files, or root deployment artifacts from tests.

## Lightweight Governance UI Plan

CLI remains sufficient for R9 if operators can inspect, disable, delete, restore, redact display profiles, and explain context. A lightweight UI becomes necessary when:

- non-technical users need self-service memory review;
- memory proposals need batch approval;
- `/why` traces need comparison across turns;
- display identity redaction/unlink workflows become frequent.

P0 UI scope if built later:

- read-only memory list with filters;
- memory detail with source/revision/audit links;
- disable/delete/restore actions through the same governed repository path;
- context explanation view backed by CLI `why` logic;
- display profile/nickname redaction form;
- no raw secret/audit full payload rendering by default.

## Deployment Notes

Start simple:

- One VPS or local machine.
- One SQLite database.
- One bot account.
- One QQ group.

Add Redis, vector services, and split workers only after the simple deployment shows clear pressure.
