# Next Codex Constraints

**Purpose:** hard operating constraints for the next Codex worker. This document supplements `AGENTS.md` and supersedes the old “keep looping through micro-slices” behavior.

## 1. Evidence Authority

1. Current worktree, command output, test results, and database assertions are authoritative.
2. Historical completion docs, archived reviews, and prior assistant summaries are clues only.
3. Do not claim a phase is complete without fresh evidence that covers the scope of that claim.
4. Do not treat “tests passed earlier” as current proof after modifying code.
5. If docs and code conflict, record the conflict and verify behavior from code/tests/DB.

## 2. Stop the Loop

The previous long-running loop became too repetitive. The next worker must:

1. Do at most one coherent implementation slice before stopping to report.
2. Prefer high-value stabilization or production-readiness work over additional tiny parser/redaction variants.
3. Avoid re-reading every long document on every micro-step. Read the handoff docs first, then only the domain docs relevant to the touched area.
4. Avoid append-only status bloat. Add concise evidence summaries; do not paste huge command logs into docs.
5. If the best next action is unclear, present 2-3 concrete options rather than silently continuing low-value work.

## 3. Baseline Gate

Before code changes:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm typecheck
pnpm lint
pnpm test:run
git diff --check
```

If `typecheck`, `lint`, or deterministic tests fail, do recovery only.

For docs-only changes, `git diff --check` is the minimum final check; running the full gate is optional unless the docs claim code behavior changed.

## 4. Git and Worktree Hygiene

1. Do not commit unless the user explicitly authorizes commits.
2. Do not stage broad paths.
3. Do not delete untracked files unless the user explicitly authorizes cleanup.
4. Treat dependency and lockfile changes as reviewed code.
5. Never commit `.env`, logs, SQLite DBs, generated secret files, local acceptance evidence containing private IDs, or scratch credentials.

## 5. Secret and Identifier Handling

Do not read or print:

- `.env` or local secret files;
- API keys, tokens, cookies, private keys, recovery codes;
- local logs or SQLite DBs unless explicitly required and safe;
- private QQ IDs/group IDs/account IDs.

Real acceptance may read local secret files only when explicitly authorized, and secret contents must never be written to the repo or chat output.

## 6. Architecture Boundaries

Maintain these module boundaries:

- Gateway adapts OneBot/QQ protocols only.
- Ingestion writes raw events before derived records.
- Memory extraction proposes; governed memory services write durable memory.
- ContextBuilder owns retrieval, ranking, filtering, budgeting, and prompt/context trace assembly.
- Pi owns reasoning/tool proposals but does not directly write durable storage or send platform messages.
- Tools go through registry, policy, sandbox checks, audit, and redaction.
- Workers are idempotent and source-linked.
- Governance CLI/UI can inspect and modify governed memory with audit/revision evidence.

## 7. Data Integrity

1. SQLite foreign keys must be enabled in persistence tests.
2. Raw events are audit roots.
3. `chat_messages.raw_event_id` must reference a real raw event unless a documented synthetic event strategy exists.
4. Durable memory writes must include:
   - `memory_records`;
   - `memory_sources`;
   - `memory_revisions`;
   - relevant `audit_log`.
5. Retrieval must exclude deleted/disabled/superseded/secret/prohibited/private-in-group records as appropriate.
6. Tests must assert DB rows and FK validity, not only mocked calls or HTTP status.

## 8. Testing Rules

Default deterministic tests must not require real provider credentials, NapCat, SnowLuma, or a live QQ session.

Strong tests assert:

- persisted rows;
- FK validity;
- selected/rejected context evidence;
- redaction and non-leakage;
- action/tool/job outcomes;
- failure observability.

Weak tests only assert:

- HTTP 200;
- method was called;
- array length;
- mock success without DB side effects.

## 9. Real SnowLuma / QQ Acceptance

Production readiness is unproven until a controlled local soak proves:

- QQ private loop works;
- QQ group loop works;
- mention/reply behavior is correct;
- replies go through action executor;
- governed memory affects answers without privacy leakage;
- evidence is redacted and validator-clean.

If real local runtime is unavailable, record it as unproven. Do not simulate it and claim production readiness.

## 10. Documentation Rules

1. Prefer concise, current summaries over giant appended logs.
2. Every status update must include date, commands, pass/fail summary, changed paths, and known gaps.
3. Do not write “complete” unless all scoped criteria are verified.
4. Mark real SnowLuma/QQ acceptance as unproven unless actually run.
5. Keep `docs/archive/**` historical.

## 11. Reporting Format

At the end of a slice, report:

- current phase/status;
- commands run and results;
- files changed;
- evidence-backed behavior;
- remaining gaps;
- exact recommended next step.

Do not mark the full long-term goal complete unless every explicit requirement is verified, including real controlled SnowLuma/QQ acceptance.
