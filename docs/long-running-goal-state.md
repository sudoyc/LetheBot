# Long-Running Goal State

**State type:** active checkpoint, not a completion certificate
**Updated:** 2026-08-07 02:51 CST (+0800)
**Program:** repair-and-long-term-development goal
**Program verdict:** `LOCAL_COMPLETE_EXTERNAL_BLOCKED`
**Product verdict:** `DETERMINISTIC_READY`; production/live acceptance is not complete

This file is intentionally concise. It replaces the former append-only execution
journal. Canonical requirements live in
`docs/long-term-development-constraints.md`; historical detail remains available
in Git history and `docs/archive/`. Resume work from this checkpoint, current
code, and current verification output—not from old completion claims.

## 1. Authority And Proof Boundary

Authorized in the current program:

- local source, test, migration, documentation, and deterministic acceptance work;
- disposable synthetic databases, processes, environment files, and release
  rehearsal artifacts;
- commits and pushes required by the active repository-completion objective.

Not authorized in the current program:

- reading existing credentials, private QQ data, operator databases, or historic
  private runtime artifacts;
- connecting to a real Provider or QQ/NapCat deployment;
- restarting or disrupting a real deployment;
- treating synthetic evidence as live evidence.

Fresh `LIVE_PROVIDER`, `LIVE_QQ`, and `LIVE_DEPLOYMENT_OR_RESTART` authority is
absent. Those boundaries remain fail-closed.

## 2. Verified Candidate Snapshot

- Verified candidate source commit before this checkpoint update: `65fde07` (`main`, tracking `origin/main`); the worktree was clean.
- Pi dependencies: `@earendil-works/pi-agent-core 0.83.0` and
  `@earendil-works/pi-ai 0.83.0`.
- Candidate scope: reviewed tool-catalog configuration plus the accumulated local
  program changes listed in section 6.
- No live Provider, QQ, deployment restart, production restore, or private-data
  operation was performed. The Framework Compose path was not started, stopped,
  rebuilt, or recreated during this audit; its persistent SnowLuma/QQ bind
  directories and shared ports remain protected.
- The source-stack images were built successfully with `--env-file /dev/null` and
  `--pull=false`; no Compose service was started by this audit.
- Both Compose files passed `config --quiet` with `/dev/null`; this is config
  inspection only, not runtime or QQ evidence.

Current deterministic release gate, run against the candidate at
2026-08-07 02:47 CST:

```text
pnpm release:check
  typecheck + test typecheck: passed
  eslint: passed
  build: passed
  release preflight: passed (5 required files)
  package dry run: passed (606 files)
  Vitest: 140 passed, 1 skipped files
          2957 passed, 10 skipped tests
  total elapsed: 159.54s
```

Additional current deterministic evidence:

```text
pnpm smoke: all smoke checks passed.
pnpm --silent ops:worker-soak -- --duration-ms=15000 --interval-ms=1000:
  success=true; 22 attempts (21 completed, 1 planned retry); 21 jobs completed;
  lease extension observed; scheduler errors=0; isolation clean; FK violations=0.
pnpm --silent ops:rehearse-maintenance: success=true; disposable backup/restore/
  retention rehearsal; integrity and foreign-key checks clean.
pnpm --silent ops:rehearse-rollback: success=true; disposable rollback rehearsal;
  integrity and foreign-key checks clean.
pnpm --silent acceptance:db-summary on a disposable restored DB:
  integrity=true, foreign-key violations=0; --require-acceptance-hints exited 1
  because populated live acceptance rows are absent.
pnpm --silent ops:doctor on the same disposable DB:
  overall=ok; 25/25 required tables; foreign-key violations=0.
Fresh acceptance template plus default validator: valid=true, findingCount=0.
The same template with --require-complete exited 1 with findingCount=119;
this is the expected incomplete-live-evidence result, not a product-gate failure.
```

No live Provider/QQ/runtime claim is inferred from these deterministic results.

## 3. P0–P9 Contract Audit

Status vocabulary:

- `PROVED`: the phase's current deterministic exit contract is covered by code,
  tests, and current gate evidence.
- `DETERMINISTIC_READY`: local behavior is proved, but a named live exit item is
  still authorization-bound.
- `BLOCKED_EXTERNAL`: the next valid evidence requires fresh live authority or
  operator infrastructure.

| Phase | Status | Current evidence | Remaining boundary |
|---|---|---|---|
| `P0` Baseline and risk map | `PROVED` | Clean base commit identified; canonical constraints, migrations, scripts, test inventory, and deterministic release gate are current. | None local. |
| `P1` Security and privacy gates | `PROVED` | Loopback/auth/body limits, redaction, bounded audit/log output, and fail-closed startup/transport contracts remain covered by the full suite. | Production exposure is rechecked in `P4`/`P9`, not inferred here. |
| `P2` Scheduling and recovery | `PROVED` | Durable admission, claims, heartbeats, recovery, queue saturation, cancellation, shutdown, and group-summary scheduling are covered by repository/worker/application/integration tests. | Live restart and long soak belong to `P9`. |
| `P3` Invocation ledger and Pi concurrency | `PROVED` | Durable model invocation state, prepared-call boundaries, cancellation/timeout behavior, evaluator isolation, and Pi concurrency contracts pass the current suite. | Provider-observed behavior belongs to `P4`. |
| `P4` Live Provider and QQ baseline | `BLOCKED_EXTERNAL` | Deterministic harnesses and evidence validators exist. Historic live samples are not evidence for this candidate. | Fresh Provider/QQ/restart authority and the complete live matrix are absent. |
| `P5` Memory lifecycle | `PROVED` | Memory proposals, review/apply/rollback, provenance, visibility, deletion, conflict/consolidation/decay, and governed retrieval paths are covered by storage/worker/governance/context tests. | Real-runtime recall/privacy samples are part of `P4`/`P9`. |
| `P6` Tool registry and execution | `DETERMINISTIC_READY` | Exact reviewed catalog, policy/evaluator/audit/sandbox/output bounds, optional tools, owner inspection, and restart-scoped enable/disable configuration pass focused and full gates. | One allowed and one denied tool call in real authorized QQ remain live evidence. |
| `P7` Application orchestration | `PROVED` | Composition root, turn lifecycle, QQ command path, governed memory/context/tool flow, failure mapping, and shutdown ownership pass unit/integration/e2e coverage. | Live behavior is not claimed. |
| `P8` Governance and operations UI | `PROVED` | CLI, QQ governance commands, authenticated loopback governance listener, browser workflows, privacy controls, maintenance, backup/restore handoff, retention controls, and deterministic accessibility/security QA are covered by current local contracts. | Production browser screenshots/accessibility sign-off and actual stopped-service restore remain live/operator work. |
| `P9` Release and sustained operation | `BLOCKED_EXTERNAL` | Deterministic install/update/rollback rehearsal, immutable release artifact work, validators, and a one-hour synthetic concurrent worker soak were completed in the current program; the current package gate passes. | Planned real restart/fault injection, actual stopped-service restore, complete live matrix, and 72-hour real soak are absent. |

No phase is labeled production-complete. `P4`, the live parts of `P6`, and `P9`
must not be promoted from local tests or synthetic evidence.

## 4. Cross-Phase Requirement Matrix

| Area | Status | Evidence summary | Next valid proof |
|---|---|---|---|
| `SEC` | `PROVED` | Deterministic auth, ingress, body, redaction, privacy, audit, and bounded-output contracts pass. | Recheck the deployed surface during authorized acceptance. |
| `GW` / `ING` | `DETERMINISTIC_READY` | OneBot normalization, dedupe, commands, transport failure, and admission tests pass. | Real QQ private/group ingress and reconnect matrix. |
| `TURN` / `CTX` / `PI` | `DETERMINISTIC_READY` | Durable turn ownership, context budgets, invocation ledger, cancellation, evaluator, and concurrency tests pass. | Authorized Provider quality, timing, and concurrency observations. |
| `ACT` | `DETERMINISTIC_READY` | Durable effects, idempotency, retry/failure boundaries, and redacted action evidence pass. | Real outbound delivery/failure samples. |
| `MEM` | `DETERMINISTIC_READY` | Source-linked governed lifecycle, retrieval, visibility, deletion, and maintenance pass. | Real-runtime recall and privacy samples. |
| `TOOL` | `DETERMINISTIC_READY` | Reviewed exact catalog, policy/evaluator/audit/sandbox limits, owner inspection, and restart-scoped configuration pass. | One allowed and one denied real QQ tool call. |
| `WORK` | `DETERMINISTIC_READY` | Claims, leases, recovery, heartbeats, saturation, shutdown, and one-hour synthetic concurrency are covered. | 72-hour real soak and restart/fault evidence. |
| `GOV` | `PROVED` | CLI, QQ commands, governance HTTP/browser workflows, scope/preview handles, privacy, maintenance, and local accessibility/security contracts pass. | Production operator sign-off. |
| `OPS` | `DETERMINISTIC_READY` | Doctor, metrics, backup/restore handoff, retention, release activation/rollback, packaging, and validators are implemented and locally exercised. | Actual stopped-service restore and controlled deployment rollback. |
| `LIVE` | `BLOCKED_EXTERNAL` | Templates and validators exist; current-candidate live records do not. | Fresh authority, then complete every required evidence cell. |
| `DOC` | `PROVED` | Canonical architecture/contracts/security/deployment/operations/test/tool docs match the current implementation; this checkpoint is current and concise. | Update only after new verified behavior or live evidence. |

## 5. Completed Final Local Slice: Reviewed Tool Configuration

The current slice closes the local owner/operator configuration gap without
adding a hot-mutation path:

- `KNOWN_TOOL_NAMES` defines the nine reviewed canonical names:
  `memory.search`, `memory.propose`, `memory.disable`,
  `group.recent_summary`, `runtime.status`, `runtime.tools`,
  `workspace.list`, `workspace.read_text`, and `web.fetch_text`.
- `LETHEBOT_DISABLED_TOOLS` is parsed and validated before database
  initialization. Empty/unset means no disabled tools; duplicates and unknown
  names fail startup.
- Registry entries now expose explicit `enabled` state. Disabled entries remain
  registered and owner-inspectable, but are excluded from Pi availability and
  handler lookup for new calls. In-flight calls are not interrupted.
- Private owner/admin `runtime.tools` returns only bounded redacted catalog
  metadata, explicit enablement/current-context availability, evaluator flags,
  and counts. It cannot mutate runtime state.
- Owner CLI commands `list-tools`, `tool-status`, `disable-tool`, and
  `enable-tool` inspect or atomically update an explicitly supplied launcher env
  file. Mutation rejects symlinks, preserves unrelated settings and mode, and
  reports that restart is required.
- Optional workspace and web tools remain conditionally registered; configuration
  does not invent handlers or permissions.
- CLI action validation is fail-closed at runtime as well as in TypeScript types.

## 6. Candidate Paths

All current candidate paths are intentional and within the active program:

```text
.env.example
README.md
docs/architecture.md
docs/contracts.md
docs/deployment.md
docs/long-running-goal-state.md
docs/operations.md
docs/security-privacy.md
docs/test-strategy.md
docs/tool-registry.md
src/cli/main.ts
src/cli/tool-config.ts
src/config/index.ts
src/index.ts
src/scripts/local-acceptance-evidence.ts
src/tools/builtins/runtime-tools.ts
src/tools/known-tools.ts
src/tools/registry.ts
tests/integration/cli-main.test.ts
tests/unit/cli/tool-config.test.ts
tests/unit/config/index.test.ts
tests/unit/index-pi-runtime.test.ts
tests/unit/pi/pi-adapter.test.ts
tests/unit/scripts/local-acceptance-evidence.test.ts
tests/unit/tools/registry.test.ts
tests/unit/tools/runtime-tools.test.ts
```

No dependency or migration file is changed by this final slice.

## 7. Remaining Blockers

The repository is locally complete under the deterministic contract. The product
is not fully completed because these required acceptance items are absent:

1. Complete real Provider/QQ matrix: private and group turns, reply-to-bot and
   ordinary mentions, silence/response decisions, allowed/denied tools, memory
   extraction/recall/privacy, cancellation, timeouts, provider and delivery
   failures, duplicate ingress, saturation, recovery, and concurrent turns.
2. Controlled real restart/fault-injection run with durable turn/job/action
   recovery evidence.
3. Actual stopped-service backup/restore and deployment rollback evidence.
4. Continuous 72-hour real runtime soak with no unexplained loss, duplicate
   effect, privacy leak, or unbounded growth.
5. Production browser accessibility/visual operator sign-off.
6. Share-safe validation and complete validation of the populated current-candidate
   evidence set. A fresh empty template is share-safe (`valid=true`, zero findings),
   but `--require-complete` exits 1 with 119 findings because populated live
   evidence is absent.

Historic samples, deterministic harness results, the one-hour synthetic soak,
and empty/template evidence cannot satisfy these items.

## 8. Exact Resume Action

Do not open another speculative local feature slice. Before any runtime acceptance,
keep `docker-compose.snowluma-framework.yml` off-limits without fresh live
authority: it references the real SnowLuma image, `restart: unless-stopped`,
persistent framework bind directories, `SNOWLUMA_HOOK_AUTOLOAD=1`, and ports shared
with the source stack. This audit used only `/dev/null` config checks and a
source-stack image build; it did not start any stack or stop/recreate any service.

The next valid action is:

1. obtain fresh, explicit `LIVE_PROVIDER`, `LIVE_QQ`, and
   `LIVE_DEPLOYMENT_OR_RESTART` authority plus a controlled runtime and test
   identities;
2. run the `P4` matrix and populate only redacted current-candidate evidence;
3. run the planned restart/fault and actual restore/rollback scenarios;
4. run the 72-hour real soak;
5. run share-safety and completeness validators;
6. update this checkpoint and the affected canonical docs from observed results.

Without that authority and infrastructure, status remains
`LOCAL_COMPLETE_EXTERNAL_BLOCKED`; do not fabricate completion, read private
artifacts, or substitute synthetic evidence.
