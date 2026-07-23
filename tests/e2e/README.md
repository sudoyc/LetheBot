# Real Provider E2E Tests

This directory contains deterministic application coverage and opt-in tests for
the Pi/DeepSeek provider path. The normal gate does not require network access
or provider secrets.

## Files

```text
tests/e2e/
├── deepseek-real-api.test.ts  # deterministic harness guard; no network calls
├── full-memory-cycle.test.ts  # deterministic governed-memory conversation
└── pi-real-api.test.ts        # opt-in real PiAdapter/provider calls
```

`full-memory-cycle.test.ts` exercises the credential-free ingestion, memory,
context, action, and response path against a disposable SQLite database.

`deepseek-real-api.test.ts` intentionally verifies only configuration gating. It
prevents legacy placeholder checks from being mistaken for real-provider
evidence and does not read local secret files.

`pi-real-api.test.ts` is the authoritative real-provider E2E suite. It exercises
`PiAdapter` with a live provider only when explicitly enabled. Its governed-tool
probe also verifies that the evaluator decision is linked to one completed
durable evaluator invocation; an evaluator-version string alone is not
Provider-call evidence.

## Default deterministic behavior

Run the default e2e subset without credentials:

```bash
pnpm exec vitest run tests/e2e/deepseek-real-api.test.ts tests/e2e/pi-real-api.test.ts --silent
```

Expected behavior without opt-in credentials:

- `deepseek-real-api.test.ts` passes its deterministic guard tests.
- `pi-real-api.test.ts` is skipped.
- No local secret files are read.
- No provider network calls are made.

## Opt-in real-provider run

Real provider tests require both:

1. `LETHEBOT_RUN_REAL_API_TESTS=1`
2. `PI_API_KEY` or `DEEPSEEK_API_KEY`

Example:

```bash
LETHEBOT_RUN_REAL_API_TESTS=1 \
PI_API_KEY='<redacted-provider-key>' \
pnpm exec vitest run tests/e2e/pi-real-api.test.ts --silent
```

Optional provider settings:

```bash
export PI_PROVIDER='openai'
export PI_MODEL='deepseek-chat'
export PI_BASE_URL='https://api.deepseek.com/v1'
```

DeepSeek-specific aliases are also accepted by the tests:

```bash
export DEEPSEEK_API_KEY='<redacted-provider-key>'
export DEEPSEEK_MODEL='deepseek-chat'
export DEEPSEEK_BASE_URL='https://api.deepseek.com/v1'
```

Use environment variables only. Do not rely on `~/deepseek`, `.env` files, or
other local secret files for these tests.

## What the live suite covers

When explicitly enabled, `pi-real-api.test.ts` checks:

- simple private-chat turns through `PiAdapter`;
- Chinese response handling;
- tool registration and tool execution through the LetheBot registry/policy path;
- durable real-evaluator invocation linkage for the governed-tool probe;
- multi-turn context with assistant history;
- invalid-key failure reporting without echoing the test key;
- network-failure behavior through a non-routable endpoint;
- tool-handler failure behavior.

This is still provider-path evidence only. It is not a substitute for controlled
SnowLuma/QQ acceptance.

## Evidence handling

When recording results:

- report command exit status and aggregate pass/skip/fail counts;
- report evaluator invocation/link status only as aggregate counts or booleans;
- do not copy API keys, local secret paths, raw provider headers, full request
  bodies, invocation/request/source IDs, raw chat text, private QQ IDs, or group
  IDs;
- if a failure includes provider diagnostics, summarize the redacted error class
  instead of pasting raw output;
- keep live-provider evidence separate from local SnowLuma/QQ acceptance
  evidence.

## Relationship to acceptance

Production readiness still requires the local acceptance evidence flow:

```bash
pnpm acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

Only run real SnowLuma/QQ acceptance with explicit local runtime/session
authorization and redacted evidence.
