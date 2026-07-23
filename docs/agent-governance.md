# Agent Governance

LetheBot uses agent judgement for ambiguous social, memory, and tool decisions, but the agent does not directly own high-risk execution.

This document summarizes the confirmed governance model from the archived discussion log at `archive/discussions/answer-review-discussion-log.md`.

## Evaluator Boundary

The evaluator is part of the LetheBot Orchestrator, not an unchecked Pi self-review loop.

Recommended flow:

```text
event / candidate action
  -> deterministic pre-policy gate
  -> LLM/agent evaluator with structured output
  -> deterministic policy gate
  -> relevant governed tool, memory, or action writer/executor
  -> audit log, memory revisions/repository transactions, and failure evidence
```

The evaluator may use the same underlying model API as Pi in the MVP, but it must differ in:

- invocation stage;
- prompt and input trimming;
- output schema;
- execution authority;
- audit linkage.

The evaluator can recommend actions. It cannot directly bypass LetheBot service/policy layers or mutate durable state.

In a non-test runtime, social decisions and evaluator-required Pi tools use the
configured stateless `ModelEvaluator`. Each invocation creates one isolated
provider context with no tools or retained transcript. LetheBot projects only
policy-relevant request fields, omits durable turn/source/owner and social target
identifiers, redacts secret/platform fragments per structured value, and bounds
the prompt. Strict domain schemas accept exactly one JSON object; decision IDs,
request binding, timestamps, and evaluator version are assigned locally rather
than trusted from model output. Invalid, oversized, timed-out, or throwing model
results fail closed with bounded diagnostics.
The installed `openai-completions` path requests native JSON-object output. A
strict JSON/schema failure may receive one fresh correction call, but the invalid
response is not replayed and no fence/commentary normalization is accepted.
Other failures are terminal after their current call.

Before the Provider call, the model evaluator records an exact source-bound
`model_invocations` call-1 row owned by the turn or extraction attempt. It
terminalizes every started call: valid parsed output records token counts and a response
digest/size, while deadline, abort, Provider, empty, oversized, and schema errors
record only a bounded failure code. Call 2 is legal only after the same request's
call 1 ends as `invalid_structured_output`, with identical authority, model,
prompt version, and ordered sources; no third call is allowed. The resulting decision is linked through
`evaluator_decisions.model_invocation_id` only after the writer verifies exact
request/domain/owner/source/provider/model/prompt and timestamp agreement. No
prompt, response, credential, endpoint, or platform identifier is copied into
the invocation ledger.

Evaluator provider/model inherit together from Pi only when neither identity
field is overridden. `EVALUATOR_BASE_URL` and `EVALUATOR_API_KEY` may override
the inherited endpoint/key independently; when provider/model are overridden,
the Pi endpoint/key are not inherited and required values must be supplied for
that evaluator. `EvaluatorStub` is selected for explicit test operation or when
the resolved evaluator provider is `mock` (the model value does not control stub
selection); non-mock production does not silently fall back to it.

Background memory extraction uses that same configured evaluator under exact
current job-attempt/lease authority. Its model invocation, evaluator decision,
and governed memory or rejection evidence remain separately auditable: the call
is terminalized before the decision transaction, and an authority or effect
failure rolls back the decision/business rows while preserving truthful terminal
call evidence. Test/mock operation continues to use the rule-driven stub and
creates no model invocation.

When model evaluation itself terminates unsuccessfully, no domain invents an
evaluator decision. Social records an evaluator-required, `evaluatorPassed=false`
all-silent decision with a fixed suppressor; memory records one idempotent
content-free rejection audit and no memory effect; required tools record rejected
tool/audit evidence with `EVALUATOR_ERROR` and do not call the handler. Evaluator
diagnostics are not copied into those business rows.

## Structured Decisions

Evaluator outputs should be structured records, not free-form permission text.

Every evaluator result uses `approve`, `reject`, `downgrade`, or `propose`.
Memory-domain results may additionally recommend `active` or `proposed` state,
visibility/sensitivity, and conflict handling. Social-domain results use the
action types in `social-action-model.md`; tool-domain results use the governed
tool fields in `tool-registry.md`. `ask_owner`, `ask_subject`, and free-standing
`redact` are not current evaluator/action enum values.

Every high-risk structured decision should link to:

- source event IDs;
- actor/context;
- reason summary;
- confidence/risk level;
- evaluator version and, for model-backed decisions, the exact completed
  invocation link;
- executor result;
- audit entry.

The current social-action path writes this evidence to `evaluator_decisions`
and foreign-key links the resulting `action_decisions` row. Evaluator evidence,
the action decision, and the turn's action link are one transaction. The ledger
keeps exact request/decision identity, evaluator version, actor/context,
source-event IDs, and request/decision timestamps, while free-text evaluator
reasons are redacted and limited to 2,048 characters, including a truncation
marker, before storage. Repository validation checks social domain, action
outcome metadata, and raw-event provenance rather than trusting TypeScript
literals at this runtime boundary. It intentionally does not retain the bounded
evaluator context summary or proposed payload as a second copy of chat content.
Passing or evaluator-owned social action state cannot be created from caller
booleans alone. The social evaluator receives a detached request, request
mutation aborts before persistence, and the repository derives evaluator
identity/pass state from the validated result. Pending non-passing decisions may
remain durable for rejection evidence, but they carry no execution approval.

Each new action decision also stores a versioned HMAC commitment to its detached
unredacted envelope. The process-local key is not persisted. The executor clones
and verifies the supplied decision, its durable scalar/redacted representation,
and any same-turn approving evaluator join synchronously before an awaited
effect. Redacted durable actions are inspection evidence only. Legacy/unbound or
different-process decisions fail closed rather than being replayed.

## L0 Hard Policy

L0 policy is not a question for the LLM to waive during a turn. Owner configuration may change deployment defaults, but such changes must be explicit, auditable, and reversible.

Minimum L0 invariants:

1. `secret` / `prohibited` content does not enter ordinary prompts.
2. `deleted` / `disabled` memory is excluded from retrieval immediately.
3. `private_only` memory is not publicly referenced in group chat by default.
4. Raw QQ IDs, group IDs, and account IDs are operational identity data, not ordinary memory. They may enter prompts when needed for identity disambiguation, platform operations, user-requested ID handling, or debug, but must be purpose-bound, minimal, and structured.
5. Pi, evaluator, and tools do not bypass LetheBot service/policy layers to mutate durable storage.
6. High-risk execution leaves an audit trail.
7. The action executor rejects gateway side effects, governed-memory writes,
   and durable job-scheduling side effects when a direct caller supplies
   `riskLevel="prohibited"` or an evaluator-required action without
   `evaluatorPassed=true`; `silent_store` may still record no-op audit/control
   evidence for why no side effect was taken.
8. Caller approval flags and durable redacted action JSON are not execution
   authority; the exact same-process reviewed decision must pass its repository
   binding, exact evaluator-authorized-plan check, evaluator-join metadata check,
   and current-turn decision-link check before effects. Passing prohibited
   evidence and unmatched downgrades fail closed.
9. Outbound durable-memory claims require exact, turn-bound evidence. A proposal
   may be described only as pending review, and absent or ambiguous evidence
   produces neutral wording before delivery.

## Evaluator Policy Vocabulary

Current runtime tool metadata has a per-tool `evaluatorPolicy` field. Grouped
memory/social toggles below are a future configuration shape, not implemented
environment or runtime configuration today. Evaluator policy does not enable or
disable the underlying feature.

Use this vocabulary:

```yaml
evaluatorPolicy:
  tools:
    sandboxRun:
      evaluatorPolicy: required # required | bypass
  memory:
    autoActiveLowRisk:
      evaluatorPolicy: required
  social:
    proactiveGroupReply:
      evaluatorPolicy: required
```

`evaluatorPolicy: bypass` means:

- bypass the LLM evaluator for that action class;
- still enforce L0 hard policy;
- still enforce permissions;
- still execute through the relevant governed tool, memory, or action boundary;
- still apply audit/sandbox policy where required.

Do not model evaluator policy as `enabled: true | false`. Feature availability belongs to installation/configuration, not risk review.

## Policy Groups

The initial policy groups are:

- `tools` — tool execution, sandbox, network, file writes, long-running jobs.
- `memory` — automatic active memory, cross-scope injection, memory edits/supersede.
- `social` — proactive group replies, proactive DM, sensitive topic replies, private-memory mentions.

A global unsafe mode is intentionally avoided. Different risk surfaces need separate controls.

## Memory-Claim Truthfulness

Prompt instructions and evaluator approval do not prove that a memory effect
occurred. The action boundary accepts durable wording only for the exact
proposition, subject, scope, source, lifecycle state, and action target supported
by a selected active memory. A fully committed same-turn `memory.propose` chain
supports pending-review wording only; a proposed action or partial chain does
not.

Unsupported claims are corrected before action redaction, binding, persistence,
and delivery. The correction is recorded with the
`memory_claim_truthfulness_guard` suppressor, avoids echoing unsafe proposition
text, and does not create or change memory state. The pre-guard Pi draft remains
separate turn evidence and is not the delivered bot response.

## QQ Governance Command Boundary

QQ governance uses only this exact, case-sensitive grammar:

```text
/memory
/memory forget <memory-id>
/memory summary status
/memory summary enable
/memory summary disable
/why
```

The parser accepts surrounding/inter-token whitespace, rejects recognized input
longer than 512 characters, and limits `<memory-id>` to 1-128 characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`. A `/memory` or `/why` token with invalid trailing
syntax is still recognized. After authority is proven it receives bounded usage
output; without authority it receives the same denial as a valid command. Prefix
collisions such as `/memoryx` and `/whyever`, arbitrary `!` commands, and
narrative management/settings text are ordinary input. There is no
natural-language governance router.

Recognized commands are intercepted after identity/display handling and before
Attention. The application stores the command chat row, creates a zero-token
local turn (`provider=local`, `model=qq-governance-v1`), and calls the shared
`GovernanceService`. The service does not trust the in-memory event: it rereads
and strictly reconciles the one canonical QQ gateway raw event, derived chat
row, normalized payload, active platform account, and canonical user, then
reparses the stored text and reauthorizes the actor. Every recognized command,
including a command from an unauthorized member, bypasses Pi, the evaluator,
and tools. Unauthorized commands receive the fixed deterministic denial.

Authority is either the sender whose normalized QQ account exactly matches the
optional `LETHEBOT_BOT_OWNER_QQ_ID`, or the persisted `owner`/`admin` sender role
for the exact current group. Group command scope additionally requires the group
and conversation IDs to be the same canonical
`qq-group-[1-9][0-9]{4,11}` value. Ambiguous duplicate raw/chat derivations and
malformed command scope fail verification. Group authority never transfers
between groups.
`/memory` in a group lists only non-secret, non-deleted memory safe for the exact
group/conversation: exact-group records, exact-conversation records, and
same-group user records. It never lists private/global/other-group memory, even
for the bot owner. Only the configured bot owner may use the broader private-chat
listing. Exact-group owner/admin `forget` is limited to that same safe set; the
bot owner and local CLI may forget a known memory ID broadly. Missing,
already-deleted, or unauthorized IDs share one unavailable response, and a
successful forget creates the ordinary delete revision/audit and disappears
from retrieval immediately.

Summary commands require a group conversation and affect only that exact group.
The policy defaults off when no row exists. Enable/disable transitions advance
the policy generation and are audited with actor/source evidence; repeating the
current state is idempotent. Disable immediately blocks enqueue and retrieval,
atomically fails/cancels bound pending summary jobs, and retains existing
summary memory. Enable/re-enable use an exclusive epoch beyond the prior policy
clock, all persisted exact-group chat ingress, and normalized exact-group raw
ingress still awaiting chat normalization. Disable advances beyond pending
binding/job clocks when representable and saturates at the safe-integer ceiling.
A new generation therefore never backfills the disabled or pre-enable interval,
including after wall-clock rollback. `/why` returns bounded, redacted aggregate evidence for
the latest prior QQ turn in the exact conversation, selected by canonical raw
ingress order; it cannot select a later, private, or other-group turn.

The command reply is an Attention-decided, evaluator-free, non-proactive
`reply_short`/`reply_full` action executed only by `ActionExecutor`. Successful
delivery stores the exact delivered text as `bot.response`; duplicate ingress
does not repeat the turn, effect, or send. The governance mutation/audit and
reply decision commit in one immediate transaction; decision-persistence
failure rolls them back before delivery and records a failed local turn/admission.
A handled send failure leaves the
zero-token local turn completed with durable failed execution and no
`bot.response`. A thrown service/repository or post-send persistence failure
uses the ordinary failed-turn and failed-admission evidence path.

CLI `delete-memory` and `memory-summary <status|enable|disable> --group <id>` use
the same service with the fixed `local_admin` actor and `admin_cli` context.
`memory-summary --group` accepts only
`qq-group-[1-9][0-9]{4,11}`. Their output is bounded/redacted, and CLI summary
changes use the same policy lifecycle, cancellation, and audit transaction as
QQ commands. Policy audit bodies redact platform/secret-shaped group/source
values and retain same-group correlation through a purpose-bound SHA-256
`groupIdHash`. Delete bodies use a bounded memory-ID projection and a
purpose-bound hashed L0 decision rather than echoing a hostile/raw ID.

## Memory Auto-Active Governance

Agent-originated memory candidates use the governed proposal path:

```text
memory candidate
  -> L0 hard filter
  -> evaluator / risk classifier
  -> structured decision
  -> governed proposal/effect writer
  -> memory_records + sources + revisions + audit log
```

Default risk handling:

- low risk: evaluator may auto-active;
- medium risk: evaluator may auto-active only with conservative visibility such as `private_only`, `same_group_only`, or `owner_admin_only`;
- high risk: proposal; a separate admin-digest route is a future policy option;
- secret/prohibited: reject or redact, never active.

Auto-active records must be reversible through memory revisions and excluded from retrieval immediately when disabled/deleted.

## Audit and Rollback

Governance decisions must be explainable after the fact.

For memory and high-risk actions, store:

- previous state;
- new state;
- policy/evaluator decision ID, with a durable evaluator-ledger link when that
  route is evaluator-backed;
- source IDs;
- reason;
- actor/executor;
- timestamp.

Conflicting memory should use `superseded` state or a revision rather than silent overwrite.

QQ `/why` is limited to the bounded aggregate exact-conversation response above.
The existing owner/admin CLI turn-explanation surface can show fuller traces.
For stored turn explanations, including failed turns and its default latest-turn
resolution path, that CLI surface may include linked tool-call summaries from
durable `tool_calls` rows so operators can correlate policy/evaluator rejections
or handler errors with the `agent_turns` row. Those summaries must stay
display-redacted and omit tool input/output payloads, raw runtime diagnostics,
raw event/chat text, and platform identifiers.
Required tool execution now records a source-bound `domain='tool'` evaluator
decision before the handler, links it from the terminal tool call and audit, and
rechecks L0 after approval. Evaluator output cannot waive permissions; any
non-approve, prohibited, malformed, modified-input, or unsupported-constraint
result fails closed.
Owner/admin CLI action-execution summaries may also include redacted executed
message, memory, and job IDs so operators can trace reply delivery, governed
memory proposals, and durable background jobs without inspecting raw gateway
logs or memory content.
