# Long-Running Goal State

**State type:** active checkpoint, not a completion certificate
**Updated:** 2026-09-08 22:32 CST (+0800)
**Program:** repair-and-long-term-development goal
**Program verdict:** `ACTIVE`
**User goal verdict:** `DEL-V3 PHASE_COMPLETE` (local deterministic scope)
**Product verdict:** release, smoke and coverage gates pass; final product/live acceptance remains open

Canonical requirements are in `long-term-development-constraints.md`; delivery
and evidence requirements are in `long-term-development-delivery.md`. This is
the only mutable checkpoint. Resume from current code and observed evidence.

**Immediate next task:** close the remaining V2 operations/documentation audit,
then freeze the complete product candidate for the final DEL-OPS/DEL-LIVE matrix.
V3 source-backed learning, governed application and rollback are complete in
the local deterministic scope. Preserve test pruning and V1/V2 implementation.
The broader program remains `ACTIVE`; this is not a live-readiness claim.

### Current V3 Slice

Requirement: `DEL-V3`. The two reproduced static errors have been fixed by
explicitly typing semantic-recall query results and formatting the parameterized
semantic-retrieval test call. `LOG_LEVEL=fatal pnpm release:check` passed with
2871 passing tests and 10 skipped, 133 passing files and one skipped, starting
21:10:26 CST (163.39 seconds for Vitest). Log:
`/tmp/lethebot-v3-V1HcAG/baseline-release.log`.

Selected storage design: extend normalized maintenance proposal kinds/effects
for governed importance adjustment; add versioned score inputs and exact source
links with deletion tombstones. No new active facts or wider visibility.
Learning uses deterministic local first-party evidence; no Provider dependency.

Schema allowed paths: `migrations/010_memory_importance.sql`, schema-version and
package schema contract, migration/preflight/rehearsal tests and schema rehearsal
assertions. Behavior paths follow only after schema verification: maintenance
proposal/repository, importance scorer/worker, governance projections, config,
application/background wiring and their focused tests/owning docs.
Protected: inherited unrelated WIP, frozen recall corpus, credentials, live
databases, deployment and Provider/QQ activity.

Schema assertions: fresh/sequential upgrade, preserve existing maintenance
records and revision/source/audit chains, repeat without writes, reject invalid
inputs atomically, integrity/FK, backup/restore and v9/v10 release rollback.
Planned tests: `tests/unit/storage/schema-v10-migration.test.ts`, existing
migration/preflight/release suites; then
`tests/integration/memory-importance.test.ts` and
`tests/integration/memory-importance-runtime.test.ts` for source/scoring,
scope/privacy, review/apply/expire/reject, failure atomicity, retry/concurrency,
restart, ContextPack ranking and rollback. Reuse shared lifecycle coverage;
do not add literal-only or duplicate CRUD tests.

Commands: focused Vitest, both typechecks, lint, release gate, disposable
`ops:rehearse-cross-version`; coverage at integrated phase exit. Prior v9 build
is preserved at `/tmp/lethebot-v3-V1HcAG/prior-v9`. Schema rollback restores the
pre-upgrade backup and uses that prior runner; runtime rollback independently
disables learning/application and restores applied ranking through revisions.

Schema slice verified at 21:31 CST: 97 focused migration/preflight tests and 69
application release tests pass. The release fixture initially still declared
v9; after correcting that fixture, `schema-release-final.log` records a complete
passing release gate (2875 tests, 10 skipped; 134 files, one skipped). Both
typechecks, lint, build, preflight, packaging and diff checks passed.
`schema-cross-version.log` reports every v9/v10 activation/crash/confirmation/
restore assertion true with clean integrity/FKs and stopped child processes.
`schema-compatibility.log` records the actual prior v9 runner rejecting v10 with
`future-schema-version` and zero writes. The schema-only v10 build is preserved
at `/tmp/lethebot-v3-V1HcAG/candidate-v10-schema`.

Selected behavior: bounded 30-day first-party preference window, at least three
observations on three days spanning two days. Rules support explicit Chinese
and English self-statements, reject conflicting/ambiguous same-topic evidence,
and score repetition, distinct days and span with a versioned deterministic
formula. Proposals expire seven days after the latest supporting ingress.
Defaults independently disable learning and application; rollback stays usable.

Behavior now exists in `src/memory/importance.ts`,
`src/storage/memory-importance-repository.ts`, `src/workers/memory-importance.ts`,
the existing maintenance repository, governance projections/browser modules,
config and application/background wiring. Learning runs at startup and hourly,
with frozen 20-record continuation batches and no Provider calls.

Focused verification: 221 tests across 13 importance, maintenance, governance,
HTTP authority and background suites passed; both typechecks and lint passed.
`tests/integration/memory-importance.test.ts` covers canonical source-window
scoring, exact-group authority, opt-out/account/source/expiry/revision/score
revalidation, atomic source/effect failures, concurrent review and all governed
transitions. Before-start and before-commit lease expiry cases recover the same
durable job across database reopen; the commit-expiry regression first failed
and now passes with the shared job authority check. A 21-candidate case verifies
20/1 batching, committed-batch retry without duplicate proposals or continuation
jobs, and no active-memory mutation.

`tests/integration/memory-importance-runtime.test.ts` uses actual OneBot ingress,
extraction, scheduled learning, authenticated HTTP governance and subsequent
ContextPacks. Approval leaves ranking unchanged; application raises an eligible
record from 0.40 to 0.74 and changes ordering. Another user's context excludes
it. Application restart with both controls disabled preserves the applied
ranking and permits rollback to the original order, with intact source history
and zero model invocations. This exposed a real UI discovery defect: the HTTP
review list used pending-only defaults. It now explicitly includes pending,
approved and applied proposals, preserving apply/rollback access after refresh.

`tests/integration/governance-http.test.ts` passes all 55 remaining tests,
including native Chromium score-detail and rollback controllers. The first
integrated gate exposed an obsolete source-byte/hash characterization test;
that one test was removed instead of replacing its expected digest. The
existing static asset security/module checks and actual browser interaction
checks remain. This is one additional pruning case beyond the 56-case audit
below; only that earlier 56-case pruning has an isolated coverage comparison.

Owning docs now describe the v10 contract, bounded supported grammar, formula,
expiry, controls, source tombstones, audit history and rollback. The additional
score progression regression proves 0.74, 0.85 and capped 0.95 with increasing
source evidence, with no active-memory mutation. The applied proposal's complete
score/source/revision/effect/audit chain survives the production backup/restore
APIs, retry and governed rollback. All DEL-V3 scenarios in delivery section 3
are covered at the actual storage/governance and production application boundaries.

Final verification (logs under `/tmp/lethebot-v3-V1HcAG/`):

- `LOG_LEVEL=fatal pnpm release:check`: exit 0; 2904 tests pass, 10 opt-in
  Provider tests skipped; 137 files pass, one skipped. Source/test typechecks,
  lint, build, preflight, packaging and diff checks pass (`final-release.log`).
- `LOG_LEVEL=fatal pnpm test:coverage`: exit 0, same passing suite. Statements
  85.68% (15706/18329), branches 82.53% (13382/16214), functions 93.01%
  (3035/3263), lines 85.75% (15363/17914). All four subprocess entrypoints pass
  their separate thresholds (`final-coverage.log`). No threshold or exclusion
  changed. The earlier function shortfall was closed by meaningful evaluation
  contract coverage in `tests/unit/operations/semantic-recall.test.ts`:
  uninformative embeddings cannot claim improvement, source/budget reporting
  is governed, and failed/incomplete indexing rejects. Synthetic vectors here
  are not model-quality evidence; the frozen corpus and prior real-model result
  remain unchanged.
- Smoke, disposable maintenance backup/restore/retention and database rollback
  all report success (`behavior-smoke.log`, `behavior-maintenance.log`,
  `behavior-rollback.log`).
- Built-process application activation/rollback and v9/v10 crash/confirmation/
  recovery rehearsals report every assertion true, with clean integrity/FKs and
  stopped child processes (`final-application-rollback.log`,
  `final-cross-version.log`). Commands use the frozen candidate's compiled
  `dist/scripts/application-release.js` with `rehearse` and
  `rehearse-cross-version --prior-release=.../final-prior
  --candidate-release=.../final-candidate`.

Frozen V3 builds use their own copied dependency tree, not the mutable worktree
dependency link. The initial rehearsal packaging omitted README/LICENSE, and
the same-version attempt also observed dependency fingerprint drift during
coverage. Complete independently stored artifacts resolve both issues; final
rehearsals preserve their before/after digests:

- `final-prior` (v9):
  `48c648ee26bf1aa35bc4e250c4e4bb37d5ea5b7e1aaa81a76f0e2a0f615a0fe5`.
- `final-candidate` (v10):
  `7dfe377f04a3812b3fb360f2c7057b573828e4e3d222f16b697633aa966b73c3`.
- Candidate runtime content matches the current worktree build; content digest
  `ea4c5c991c831055ee6e0998c9dab3e0495ba41858879e50d7a963d86d88c947`.
- Lockfile SHA-256:
  `0d20a2ea6885200216c327596aca3205ebdaae14a31c32974b9d4bf6bd4a6cd9`.

The final source snapshot and aggregate manifest are `final-source/` and
`final-evidence.json` under that same temporary artifact root. At snapshot
creation, they included the intended uncommitted source/tests/docs, excluding
deleted and ignored local files. This candidate is evidence for DEL-V3, not
the later full-product live acceptance candidate. No commit or push had been
performed at that point; the subsequent authorized Git handoff is recorded
below. No deployment, real Provider/QQ call or private database access was
performed.

## 1. Authority

`LOCAL_CODE_TEST_DOCS=AUTHORIZED`, `SYNTHETIC_TMP_EVIDENCE=AUTHORIZED`.
`COMMITS=AUTHORIZED`, `PUSH=AUTHORIZED` by the September 8 user request to
organize and maintain Git and push the current work. This authorizes the
existing branch's normal commit/push handoff.
`LIVE_PROVIDER`, `LIVE_QQ`,
`LIVE_DEPLOYMENT_OR_RESTART`, `PRIVATE_DB_OR_RAW_CHAT_READ`,
`DESTRUCTIVE_CLEANUP_OR_REVERT`, and `SCOPE_EXPANSION` remain `NOT_AUTHORIZED`.
No live Provider/QQ, private database, credential, or deployment operation has
been performed by this implementation goal.

## 2. Candidate And Current Evidence

- Branch: `chore/sync-pi-and-prune-tests`, tracking the same branch on `origin`.
- Source baseline: `88c587a`. Commit `c259bf7` contains the isolated 56-case
  test pruning and its guidance. Commit `bd53699` contains the integrated
  V1-V3 implementation, migrations, dependencies, tests and owning docs,
  including the additional obsolete governance source-hash test removal.
- All 430 files in the final source manifest matched the worktree before this
  Git handoff. Only this checkpoint was subsequently edited; runtime, tests,
  dependencies and the frozen corpus are unchanged from the verified snapshot.
  Reuse the final release/coverage evidence above for those committed contents.
- `git fetch --prune origin` succeeded before the handoff commits. The branch
  and fetched tracking ref both pointed to `88c587a`, with no divergence.
  This checkpoint accompanies the two implementation/test commits in the
  user-authorized normal push to the same branch. Check current Git status and
  the remote branch SHA for the completed handoff result.
- Historical September 8 audit: HEAD was five commits ahead of the locally
  cached `origin/main`, without a fetch at that time. The pre-V3 pruning
  snapshot had 47 modified tracked files, 3 deleted test files and 20 untracked
  files. That inherited V1/V2 work and the subsequent V3 work are now committed.
- Pi packages remain at `0.85.0`. V2 adds `@huggingface/transformers` `4.2.0` and
  schema v9; V3 advances the schema contract to v10. The reviewed lockfile and
  disabled ONNX/Sharp install scripts are included in `bd53699`.

### Status Audit: September 8, Before Test Pruning

Environment: Node `v26.4.0`, pnpm `11.18.0`. Checks used synthetic test data and
the previously downloaded public local embedding model. No live service,
private database or real environment file was inspected.

| Check | Observed result |
|---|---|
| `LOG_LEVEL=fatal pnpm release:check` | Exit 2 at source typecheck; later release stages did not run. |
| Source typecheck and `pnpm typecheck:test` | Both fail with TS7034/TS7005 in `src/operations/semantic-recall.ts:70` and `:97`: `queries` needs an explicit result-array type. |
| `pnpm lint` | Exit 1: `tests/unit/context/semantic-retrieval.test.ts:88`, `no-unexpected-multiline` on the split `it.each(...)(...)` call. |
| `LOG_LEVEL=fatal pnpm test:run --reporter=dot` | Exit 0; 136 files passed, 1 skipped; 2927 tests passed, 10 skipped. Started 20:25:56 CST, duration 165.40 seconds. |
| Real local-model FTS/semantic comparison | Exit 0, `success=true`; details in section 4. |
| `git diff --check` | Exit 0. |

Audit artifacts are under `/tmp/lethebot-status-audit-eZxaVA/`:
`tests.log`, `typecheck-test.log`, `lint.log`, `semantic-recall.log` and
`semantic-recall.json`. These are local audit artifacts, not an immutable final
release candidate. Build, preflight, packaging, smoke, coverage and operational
rehearsals were not separately rerun in this status audit.

### Test Pruning Audit: September 8

Removed 56 cases and three files, reducing test code by 837 lines:

- `tests/unit/e2e-helpers/deepseek-helpers.test.ts`: 33 cases asserting locally
  assigned literals, environment values and arithmetic without exercising
  project code.
- `tests/e2e/deepseek-real-api.test.ts`: five cases for an unused test-local
  configuration loader. The actual opt-in gate remains in `pi-real-api.test.ts`.
- `tests/integration/identity-resolution.test.ts`: five CRUD cases duplicated
  by the SQLite-backed identity repository suite. Both accounts resolving to
  the same canonical user are now asserted in its existing multi-account case.
- Thirteen redundant cases across MockPi, persona, logger, registry and
  FakeOneBot: combined same-input result assertions; removed static prompt-copy,
  no-op connection, instance-only and ineffective counter-reset checks. Retained
  the memory-proposal prompt rule, log redaction, registry authority/lifecycle
  and gateway message/reaction assertions.

Verification used `LOG_LEVEL=fatal pnpm test:coverage` before and after pruning.
Vitest passed both times: 2927 to 2871 passing tests, 136 to 133 passing files;
one file and ten real-provider tests remain skipped. The after run started
20:41:46 CST and took 210.66 seconds; the before run took 218.26 seconds. These
single-run timings do not establish a reliable performance improvement.

Coverage is identical before/after, including each covered statement, function
and branch: statements 85.26% (15462/18135), lines 85.35% (15151/17751), branches
82.19% (13118/15959), functions 92.54% (2993/3234). Both coverage commands exit 1
because the existing 93% function threshold is unmet. Thresholds, exclusions,
production code and dependencies were unchanged by pruning.

The separate `pnpm test:coverage:subprocess` check passes for all four required
entrypoints: lines/statements 87.21%, functions 86.26%, branches 79.86%.
Focused affected suites, environment isolation and E2E checks pass (111 tests,
10 skipped). Both typechecks and lint still report only the issues listed in
the earlier status audit; `git diff --check` passes.

Before/after coverage maps and logs, focused-test output, static-check logs and
subprocess coverage output are in `/tmp/lethebot-test-pruning-pqLA65/`.
Stable pruning rules and current E2E commands are in `test-strategy.md` and
`../tests/e2e/README.md`.

### Historical Slice Evidence: September 5

These historical checks predate the integrated V1-V3 implementation. The final
verification in Current V3 Slice is the current release-gate evidence.

- `LOG_LEVEL=fatal pnpm release:check`, started 20:13:50 CST, exit 0:
  source/test typechecks, lint, build, preflight (5 files), packaging (610 files),
  and Vitest all passed. Tests: 130 files passed, 1 skipped; 2880 tests passed,
  10 skipped. `git diff --check` passed.
- Focused V1 evidence: `tests/integration/procedural-memory.test.ts` (19 tests),
  `tests/integration/procedural-memory-runtime.test.ts` (3 tests). Source, lease,
  evaluator, revision and audit tests in the full gate cover the writer controls,
  repeated evidence and proposal-tool boundary.

V2 schema gate: `LOG_LEVEL=fatal pnpm release:check` completed at 20:30 CST,
exit 0: both typechecks, lint, build, preflight, packaging (611 files), 131 test
files / 2886 tests passed, 1 file / 10 tests skipped. Five new migration cases
first failed, then passed. Focused schema/release checks passed (162 tests).
The cross-version rehearsal initially exposed the old v7-to-v8 table assertion;
after updating it for v8-to-v9, the actual rehearsal returned `success=true`
with all assertions true. The updated release CLI integration suite passed
25 tests, and source typecheck passed. The actual prior v8 migration runner
rejects a v9 DB with `future-schema-version`, zero writes and clean FKs.

Preserved immutable schema-slice builds (not the final product candidate):

- `/tmp/lethebot-v2-releases-YaJqFd/prior-v8`, digest
  `25fbf4b8d44b7d49c95feb19176782c76853e04d484da359e3ff92b28a641db2`.
- `/tmp/lethebot-v2-releases-YaJqFd/candidate-v9-schema`, digest
  `6fd89b834646ba538e4d5482430866a831a32ff99db497f7e1fa008171a9e894`.

The schema gate predates the selected embedding dependency/runtime work.
The installed dependency adds 34 packages without changing existing package
versions; ONNX/Sharp install scripts are explicitly disabled. The public model
assets are at `/tmp/lethebot-embedding-model-dS3Xoz`, downloaded from the pinned
Hugging Face revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`. Quantized ONNX
SHA-256 matches upstream: `66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc`.

Frozen corpus: `src/memory/semantic-recall-corpus.json`, SHA-256
`65209aaa2c2458c98031659052971201b72b64b887efad8fd8d9c081175463da`.
It fixes 24 records, 11 queries, expected source IDs, k=3 and token budget=8000
before model quality evaluation. Do not tune by changing the labels or corpus.

## 3. Requirement Status

| Area | Status | Evidence and remaining work |
|---|---|---|
| Current worktree gates | `DETERMINISTIC_READY` | Final release, smoke and coverage pass. Static errors repaired, obsolete source hash assertion removed, useful evaluation-contract coverage closes the previous function shortfall. |
| P0-P3 | `DETERMINISTIC_READY` at prior slice | Baseline, security, durable admission/concurrency, invocation ledger and Pi isolation have prior acceptance and no failures in the fresh suite. The integrated release gate now passes. |
| P5-P8 | `DETERMINISTIC_READY` at prior slice | Memory governance, tools, application orchestration and local governance UI/CLI have prior acceptance and no failures in the fresh suite. Product additions need their own integration proof. |
| V1 / DEL-V1 | `DETERMINISTIC_READY` at prior slice | Explicit teaching, exact three-source repeated evidence, scoped recall, governance, lifecycle/rollback and independent controls have prior acceptance. Both procedure integration files pass in the fresh suite, including application restart with mocked Pi/sender. Final candidate acceptance remains open. |
| V2 / DEL-V2 | `REPRODUCED` | Schema, local provider, governed index, durable worker, retrieval/trace and application wiring exist. Unit/runtime tests, prior real-model comparison and current static/release/coverage gates pass; remaining V2 operations and documentation audit is tracked in section 4. |
| V3 / DEL-V3 | `PHASE_COMPLETE` | All local delivery scenarios pass: dynamic source-window scoring, exact source/revision/privacy checks, governed transitions, controls, leases, retry/concurrency/restart, backup/restore, ContextPack ranking and rollback. Integrated gates and frozen v9/v10 rehearsals pass; no live acceptance claim. |
| P4 / P6 live / P9 / DEL-LIVE | `BLOCKED_EXTERNAL` | No fresh authority or current-candidate Provider/QQ matrix, controlled deployment restart/restore/rollback, or 72-hour real soak. |
| DEL-OPS / DEL-DOC | `UNVERIFIED` for final candidate | Prior operations evidence remains, and the fresh test suite passes. Repeat smoke, coverage, all disposable rehearsals, one-hour synthetic soak and final documentation audit after V1-V3. |

Historic runtime samples, previous synthetic soaks and empty validator templates
are not evidence for the final candidate. A template passing share-safety while
failing completeness is expected and does not prove live behavior.

## 4. Selected Slice: V2 Acceptance And Gate Repair

Requirement: `DEL-V2`. Existing implementation includes
`migrations/009_memory_embeddings.sql`, `src/memory/local-embedding-provider.ts`,
`src/storage/memory-embedding-repository.ts`, `src/workers/memory-embedding.ts`,
`src/context/semantic-retrieval.ts`, ContextBuilder/trace integration and
production application/background wiring. The fresh full suite includes:

- `tests/unit/storage/schema-v9-migration.test.ts`;
- `tests/unit/memory/local-embedding-provider.test.ts`;
- `tests/unit/storage/memory-embedding-repository.test.ts`;
- `tests/unit/workers/memory-embedding.test.ts`;
- `tests/unit/context/semantic-retrieval.test.ts`;
- `tests/integration/semantic-retrieval-runtime.test.ts`.

The actual governed comparison was run with the unchanged frozen corpus:

```bash
LOG_LEVEL=fatal pnpm ops:semantic-recall -- \
  --model-directory /tmp/lethebot-embedding-model-dS3Xoz \
  --out /tmp/lethebot-status-audit-eZxaVA/semantic-recall.json
```

The output path is create-only; choose a new output filename when rerunning.
Report SHA-256:
`d7adef884f288e24a0fad7bd671b0955ec77ca9b2a2881363533c81e981580ed`.
Model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions, index v1;
runtime model fingerprint:
`8b8f385441556effd4a326e9d59efbac8eb88c83925a564cb05a8964a5ef18c4`.

| Query class | Queries | FTS recall@3 | Semantic recall@3 |
|---|---|---|---|
| English paraphrases | 4 | 0.75 | 0.75 |
| Chinese paraphrases | 3 | 0 | 1 |
| Lexical matches | 4 | 1 | 1 |

Three paraphrases were recovered, with zero lexical regressions, forbidden
selections or token-budget violations; integrity and foreign-key checks passed.
Both paths used the same 8000-token budget. Indexing took 4625 ms, recorded
embedding-process peak RSS was 694599680 bytes, and semantic query/context
durations were 11-17 ms. The `paraphrase-quiet` source remains outside the top
three in both paths; `success=true` does not mean perfect recall. This replaces
the previous model-only quality evidence, but does not close all V2 criteria.

Allowed paths: embedding runtime/repository/worker and tests; ContextBuilder,
context types/trace repository; config and application/background wiring; model
setup/recall-evaluation operations scripts; package commands and owning docs.
Keep the frozen corpus unchanged. No additional schema or live change.

Remaining acceptance: finish the V2-specific audit against all DEL-V2 scenarios
and explicitly verify index backup/restore/rebuild/rollback on disposable
databases. Typechecks, lint and the current release gate now pass. Complete the model setup, controls,
fallback/trace and evaluation runbook in owning docs. In particular,
`architecture.md` still calls embedding a future worker and
`context-orchestration.md` still describes the pre-semantic ranking path.

Rollback: feature remains disabled until explicitly configured. Terminate the
embedding child and fall back to FTS; memory truth and schema remain intact.

## 5. Exact Resume Action

1. Close the remaining V2 acceptance gaps in section 4, retaining the frozen corpus and
   current working implementation. Runtime must not download a model or send
   memory text remotely merely because a chat provider is configured.
2. Freeze the complete V1-V3 product candidate and finish the delivery-contract gates:
   release checks, smoke, coverage, disposable maintenance/restore/application
   and cross-version rollback rehearsals, one-hour synthetic soak and doc audit.
3. Complete final Provider/QQ acceptance, controlled deployment recovery and the
   72-hour real soak against that candidate once their specific authority and
   runtime details are supplied. This remains separate from local tests.

The Framework Compose deployment, its persistent SnowLuma/QQ directories, real
configuration and shared ports remain protected throughout local implementation.
