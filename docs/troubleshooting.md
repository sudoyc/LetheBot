# Troubleshooting Guide

This guide covers credential-free, non-destructive LetheBot diagnostics. Keep
runtime credentials in the process environment or the managed
`shared/runtime.env`; LetheBot does not load `.env` implicitly. Never paste
credential values, private QQ identifiers, raw chat rows, or unredacted logs
into an issue or shared evidence file.

Commands that contact a real provider or SnowLuma/OneBot can create external
traffic or social side effects. Run them only with explicit authorization and
follow [Local Container Acceptance](local-container-acceptance.md) for the
controlled flow. The checks below do not require those calls.

## Start With Bounded Health Checks

Check the local application endpoints and aggregate database health first:

```bash
curl --fail --silent --show-error http://127.0.0.1:6700/healthz
curl --fail --silent --show-error http://127.0.0.1:6700/readyz
pnpm ops:doctor -- --db="${LETHEBOT_DB_PATH:-./data/lethebot.db}"
```

`/healthz`, `/readyz`, and `ops:doctor` return bounded status and counts. They
must not return database paths, tokens, raw exception text, chat content, or
platform identifiers. See [Operations](operations.md) for response fields and
maintenance semantics.

For a managed host deployment, inspect the service without copying its full
environment:

```bash
systemctl status lethebot --no-pager
journalctl -u lethebot --since "15 minutes ago" --no-pager
```

The runtime applies log redaction, but still review output before sharing it.

## Configuration Without Secret Disclosure

Use the same explicit environment file that the service manager uses. This
prints presence flags, not credential values:

```bash
RUNTIME_ENV=/srv/lethebot/shared/runtime.env
node --env-file="$RUNTIME_ENV" -e '
console.log({
  dbPathConfigured: Boolean(process.env.LETHEBOT_DB_PATH),
  piProvider: process.env.PI_PROVIDER ?? "unset",
  piModelConfigured: Boolean(process.env.PI_MODEL),
  piKeyConfigured: Boolean(process.env.PI_API_KEY?.trim()),
  evaluatorIdentityOverridden: Boolean(
    process.env.EVALUATOR_PROVIDER || process.env.EVALUATOR_MODEL
  ),
  evaluatorKeyConfigured: Boolean(process.env.EVALUATOR_API_KEY?.trim()),
  onebotTransport: process.env.ONEBOT_TRANSPORT ?? "unset",
  onebotHttpConfigured: Boolean(process.env.ONEBOT_HTTP_URL),
  onebotWsConfigured: Boolean(process.env.ONEBOT_WS_URL),
  onebotTokenConfigured: Boolean(process.env.ONEBOT_TOKEN?.trim()),
  botIdConfigured: Boolean(process.env.LETHEBOT_BOT_QQ_ID?.trim()),
});'
```

For a checkout-local runtime, set `RUNTIME_ENV=.env`. Do not print the file or
put a token literal in shell history. The current variable names and explicit
loading examples are in [Deployment](deployment.md) and `.env.example`.

## OneBot Connection Problems

If health is good but readiness reports `adapter.ready=false`:

1. Confirm the configured transport is `ws` or `http` using the bounded check
   above.
2. Confirm SnowLuma/NapCat is running through its own service manager and
   inspect its local redacted logs.
3. Check that `ONEBOT_WS_URL` or `ONEBOT_HTTP_URL` matches the selected
   transport and that both sides agree on whether `ONEBOT_TOKEN` is configured.
4. In reverse HTTP mode, confirm SnowLuma targets
   `LETHEBOT_HOST`, `LETHEBOT_PORT`, and `LETHEBOT_EVENT_PATH` as documented in
   [Deployment](deployment.md).
5. Confirm `LETHEBOT_BOT_QQ_ID` is configured for exact group mention matching.

`pnpm verify:onebot` performs a real OneBot connection check. It is not a local
unit diagnostic: run it only when SnowLuma/OneBot access is authorized. Do not
replace it with ad hoc message, friend-list, or group-list API calls.

## Pi Runtime Failures

For a non-mock provider, startup fails closed when `PI_API_KEY` is absent. Use
the bounded configuration check above to confirm presence without revealing the
value. Also confirm:

- `PI_PROVIDER` and `PI_MODEL` name the intended configured provider/model.
- `PI_BASE_URL` is the provider API root expected by the Pi adapter, not a
  chat-completions operation URL.
- `PI_TURN_TIMEOUT_MS` is an integer in `1..2147483647` (default `120000`);
  expiry requests cooperative abort and then waits for Pi to settle.
- the service manager injects the reviewed runtime environment explicitly.
- redacted application logs and `pnpm cli list-event-failures --stage pi_inference --include-details`
  show a bounded diagnostic rather than a raw provider response.

Real-provider verification is opt-in and consumes external service capacity.
Use the authorized procedure in [the E2E README](../tests/e2e/README.md); do not
probe a provider with a credential literal embedded in a command.

## Evaluator Runtime Failures

The non-test social/tool evaluator inherits the complete Pi
provider/model/base/key identity when evaluator provider and model are both
unset. If either identity field is set, both are required and the separate path
does not inherit the Pi endpoint or key. Check only the presence flags above,
then confirm:

- `EVALUATOR_PROVIDER` and `EVALUATOR_MODEL` are either both absent or both set;
- a separate non-mock identity has `EVALUATOR_API_KEY` configured explicitly;
- `EVALUATOR_TIMEOUT_MS` is in `1..2147483647`, retries are in `0..10`, and
  temperature is in `0..1`;
- test/mock operation deliberately uses `LETHEBOT_TEST=true` or evaluator
  identity `mock` / `mock`.

Startup configuration or credential failure never falls back to the stub.
During a turn, provider errors, timeout, invalid/oversized JSON, or wrong-domain
output fail closed with bounded diagnostics. Do not paste a provider response or
credential into logs to diagnose it. Background memory extraction remains on
the stub pending its durable job/turn evaluator-authority decision.

## Database Errors

### Path And Permissions

The current variable is `LETHEBOT_DB_PATH`. For the default local path:

```bash
install -d -m 700 ./data
test -f "${LETHEBOT_DB_PATH:-./data/lethebot.db}"
for file in \
  "${LETHEBOT_DB_PATH:-./data/lethebot.db}" \
  "${LETHEBOT_DB_PATH:-./data/lethebot.db}-wal" \
  "${LETHEBOT_DB_PATH:-./data/lethebot.db}-shm"; do
  test ! -e "$file" || chmod 600 "$file"
done
pnpm ops:doctor -- --db="${LETHEBOT_DB_PATH:-./data/lethebot.db}"
```

On a managed host, the fixed `lethebot` service account needs read/write access
to `shared/data`, while the database remains mode `600`. Do not make the
database world-readable to resolve an ownership problem. Writable application
startup enforces `0600` for the resolved main DB and existing WAL/SHM files on
POSIX; readonly `ops:doctor` intentionally does not change modes.

### Schema Or Integrity Problems

Application startup applies the current initial migration idempotently.
`ops:doctor` opens the database read-only and checks required tables,
`PRAGMA integrity_check`, and foreign keys. Do not reset or manually edit a
production database when that check fails.

Use the tested backup and restore flow instead:

```bash
mkdir -p ./backups
pnpm ops:backup -- \
  --db="${LETHEBOT_DB_PATH:-./data/lethebot.db}" \
  --out=./backups/lethebot-recovery.db

pnpm ops:restore -- \
  --backup=./backups/lethebot-recovery.db \
  --db=./data/restore-check.db

pnpm ops:doctor -- --db=./data/restore-check.db
```

Replacing the service database is a stopped-service operation. After verifying
the restored copy, follow the exact overwrite procedure in
[Operations](operations.md). Restore refuses a target with live WAL/SHM
sidecars; do not delete journal, WAL, or SHM files to force it through.

### Database Locked

Identify the process that owns the configured database and stop LetheBot through
its service manager so the application can drain accepted work and close
SQLite cleanly:

```bash
lsof -- "${LETHEBOT_DB_PATH:-./data/lethebot.db}"
systemctl stop lethebot
```

Do not use an unscoped process kill or remove SQLite sidecars. If a clean stop
does not release the database, preserve the files, capture bounded service
status, and diagnose on a verified copy.

## Test And Build Failures

Start from the narrowest failing test, then run the release gate:

```bash
pnpm exec vitest run tests/unit/path/to/example.test.ts --silent
pnpm typecheck
pnpm lint
pnpm release:check
```

For watch mode, use `pnpm test`. If dependencies are incomplete, preserve the
reviewed lockfile:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Do not delete `pnpm-lock.yaml` as a cache-recovery step. Dependency and lockfile
changes are reviewed code. `dist/` may be rebuilt with `pnpm build`; the release
gate also rebuilds and preflights it.

For module-resolution failures, inspect current configuration without dumping
runtime environment files:

```bash
pnpm list --depth 0
rg -n '"type"|"module"|"moduleResolution"' package.json tsconfig.json
pnpm typecheck
```

## Message Delivery Failures

Do not test delivery by sending an ad hoc private or group message. First:

1. Check `/healthz` and `/readyz`.
2. Inspect the affected turn with `pnpm cli why --turn <turn-id>`.
3. Inspect bounded action/tool failures with `pnpm cli list-event-failures`,
   `pnpm cli list-tool-calls --status error`, and the operator commands in
   [Operations](operations.md).
4. Confirm the action decision, execution status, and stored bot-response
   evidence are linked before treating a transport response as delivery proof.

When real message delivery is authorized, use the private/group acceptance
sequence in [Local Container Acceptance](local-container-acceptance.md). That
procedure records aggregate redacted evidence and avoids unrelated recipients.

## Environment Setup

For a local mock-only setup:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm typecheck
pnpm lint
pnpm test:run
```

The application does not automatically load the copied file. Start a configured
local runtime explicitly with:

```bash
pnpm build
NODE_ENV=production node --env-file=.env dist/index.js
```

Current core variables are:

- `LETHEBOT_DB_PATH`
- `LETHEBOT_TEST`
- `LETHEBOT_HOST`, `LETHEBOT_PORT`, and the health/readiness/metrics/event paths
- `PI_PROVIDER`, `PI_MODEL`, optional `PI_BASE_URL`, `PI_API_KEY`, and
  `PI_TURN_TIMEOUT_MS` for a real provider
- optional paired `EVALUATOR_PROVIDER` / `EVALUATOR_MODEL`, optional
  `EVALUATOR_BASE_URL`, `EVALUATOR_API_KEY`, and evaluator timeout/retry/
  temperature/prompt-version controls
- `ONEBOT_TRANSPORT`, `ONEBOT_WS_URL`, `ONEBOT_HTTP_URL`, and optional `ONEBOT_TOKEN`
- `LETHEBOT_BOT_QQ_ID`

## Performance And Maintenance

Use aggregate metrics and a read-only doctor check before changing the
database:

```bash
pnpm ops:metrics -- --db="${LETHEBOT_DB_PATH:-./data/lethebot.db}"
pnpm ops:doctor -- --db="${LETHEBOT_DB_PATH:-./data/lethebot.db}"
```

Do not run `VACUUM`, mutate indexes, or experiment on the live service database
as an initial diagnostic. Take a verified backup, restore to a disposable path,
and reproduce there. Provider latency checks are real external calls and follow
the same explicit authorization requirement as other provider acceptance.

## Reporting A Problem

Include:

1. the failing command and exit status;
2. bounded `/healthz`, `/readyz`, `ops:doctor`, or test output;
3. the current revision and package-manager version;
4. minimal reproduction steps;
5. whether the issue occurs with the mock/fake runtime or only with an
   authorized real provider/OneBot runtime.

Redact credentials, private platform identifiers, raw messages, filesystem
secrets, database rows, and unbounded stack traces before sharing evidence.
