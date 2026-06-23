# Operations

The first deployment target is a small VPS or local machine.

## Runtime Processes

Recommended MVP processes:

- `gateway`: NapCat / OneBot connection and message routing.
- `api`: internal API and governance endpoints.
- `worker`: summarization, extraction, embeddings, consolidation.
- `pi-runtime`: embedded in API at first; split later only if needed.

For MVP, these can be one Node process with clear module boundaries.

## Configuration

Use environment variables for secrets and deployment-specific values:

- `LETHEBOT_DB_PATH`
- `LETHEBOT_ONEBOT_WS_URL`
- `LETHEBOT_ONEBOT_ACCESS_TOKEN`
- `LETHEBOT_AGENT_PROVIDER`
- `LETHEBOT_AGENT_MODEL`

Do not commit `.env` files.

## Observability

Log structured events:

- Gateway connection state.
- Received message IDs.
- Agent run IDs.
- Context pack IDs.
- Selected memory IDs.
- Tool call IDs.
- Worker job IDs.

Metrics to track:

- Reply latency.
- Agent token usage.
- Memory retrieval count.
- Memory promotion count.
- Deleted/disabled memory count.
- Gateway reconnect count.

## Backups

SQLite backup strategy:

- Enable WAL.
- Periodic online backup.
- Keep backups encrypted if they leave the machine.
- Test restore before relying on backups.

## Deployment Notes

Start simple:

- One VPS.
- One SQLite database.
- One bot account.
- One QQ group.

Add Redis, vector services, and split workers only after the simple deployment shows clear pressure.

