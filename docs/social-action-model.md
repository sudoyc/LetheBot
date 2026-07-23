# Social Action Model

LetheBot should not reduce group participation to a boolean "reply or ignore"
decision. Attention produces classification signals; `SocialDecisionService`
combines those signals with the Pi response and optional evaluator result into
structured actions that can be executed, downgraded, combined, or suppressed.

## Action Types

P0 actions:

- `silent_store` — record the event and recent context without replying.
- `silent_summarize_later` — enqueue background summary/memory work without replying.
- `reply_short` — short, low-disruption reply.
- `reply_full` — complete reply for explicit questions, private chat, or low-frequency technical discussion.
- `reply_with_tool` — use a tool and then respond.
  Current executor behavior treats this as the delivery step after a governed
  tool call has already completed through PiAdapter / ToolRegistry. It sends
  the prepared `payload.text` through the normal response router path with the
  same L0 prohibited/evaluator-required guards as ordinary replies; it does not
  execute tools inside the action executor.
- `propose_memory` — create a governed proposed memory record for later
  review; current executor support does not auto-activate memory.
- `admin_digest` — notify owner/admin without disturbing the group. Current
  executor support enqueues a durable `admin_digest` background job, persists
  `action_executions.executed_job_id`, and performs no gateway send.
- `schedule_background_task` — schedule a watcher, summary, reminder, or long
  task. Current executor support enqueues a known durable local background job,
  persists `action_executions.executed_job_id`, and performs no gateway send.
- `dm_user` — private-message a user from a group-triggered context.

Schema-reserved / capability-gated actions:

- `react_only` — true reaction if supported, otherwise fallback. Executor
  support is capability-gated: it requires `payload.reaction` plus
  `payload.messageId`, prefers `sendReaction`, falls back to a face/text message
  when `faceMessage` is available, and otherwise records a downgraded silent
  execution without a gateway side effect.
- `send_folded_forward` — folded/merged long reply if supported. Real folded-forward node delivery is not wired yet; current executor support is conservative fallback only: send one prepared `payload.text` as a downgraded text fallback when target/text exist, otherwise record downgraded silent evidence.

P1 action:

- `ask_clarification` — useful in private chat; cautious in groups.

Actions can be combined. Examples:

- `silent_store + silent_summarize_later`
- `reply_short + propose_memory`
- `reply_with_tool + send_folded_forward`
- `silent_summarize_later + admin_digest`

`propose_memory` action execution is local-first and governed-memory-backed.
With a `MemoryRepository` configured and a traceable turn source, the executor
creates one `memory_records` row in `state='proposed'` through
`MemoryRepository.create`, links it to the triggering `raw_event` through
`memory_sources`, writes the normal memory revision/audit evidence, persists
`action_executions.executed_memory_id`, and returns `executed.memoryId`. It
performs no gateway send and never auto-activates the memory. The executor
stores `source_context='action_executor:propose_memory'` instead of copying the
raw action-provided `sourceContext`; secret/prohibited content is rejected by the
repository policy before any memory row is written. For `scope='user'`
proposals, `memory_association=opted_out` is enforced before source lookup or
memory creation; the executor records a rejected action execution and stores no
memory rows, with rejection evidence that does not copy candidate content.
An evaluated proposal carries the linked `evaluator_decisions.id` into the
memory record, revision, and audit. A bypass proposal omits evaluator identity
and lets `MemoryRepository` assign its deterministic
`policy:l0:proposed:<memoryId>` decision instead of mislabeling the action
decision ID as evaluator evidence.

`admin_digest` action execution is local-first and job-backed. With a durable
`JobRepository` configured, the executor writes one pending `jobs` row with an
`action:admin_digest:<decisionId>` idempotency key for a single digest action,
or the same generated key plus `:actionN` only when one decision contains
multiple same-group durable jobs. The job payload is deliberately coarse and
redacted (`actionDecisionId`, action type, conversation type, digest window, and
redacted reason summary). The matching `action_executions` row is `success` and
links to that job through `executed_job_id`, so owner/admin tooling can audit the
scheduled work without reading raw chat text, platform IDs, secrets, or action
payload text. If no durable job repository is configured, the action is rejected
as not safely schedulable.

`silent_summarize_later` action execution is local-first and job-backed. With a
durable `JobRepository` configured and a target conversation, the executor
writes one pending `summary` job with an
`action:silent_summarize_later:<decisionId>:summary` idempotency key for a
single summary action, or the same key plus `:actionN` when one decision
contains multiple same-group durable jobs. It links the matching
`action_executions` row through `executed_job_id` and performs no gateway send.
The stored job payload contains only bounded action provenance, target
conversation fields, and a redacted reason summary; it does not copy raw
prompt/action payload text into the durable job.
For a group target, the executor also requires the target conversation and group
to equal the action decision's verified trigger chat source. Private-to-group,
cross-group, ambiguous-source, and cross-conversation summary actions are
rejected before enqueue. The governed summary job service then requires the
exact group policy to be enabled and atomically stores a generation-bound job
binding; the ordinary `JobRepository` path remains valid only for private
summaries.

`schedule_background_task` action execution is also local-first and job-backed.
With a durable `JobRepository` configured, the executor accepts only known local
durable task types (`summary`, `extraction`, `consolidation`, `decay`,
`conflict`, `admin_digest`, and `retention`), writes one pending `jobs` row, and
links the matching `action_executions` row through `executed_job_id`. The
idempotency key is generated as
`action:schedule_background_task:<decisionId>:<taskType>` rather than copied
from the action payload. A single action keeps that backward-compatible key;
only duplicate durable-job groups in the same decision receive deterministic
`:action1`, `:action2`, ... suffixes so two same-type jobs do not collapse into
one row. The stored job payload keeps redacted task fields at top level so
durable workers can consume ordinary fields such as `conversationId` /
`groupId`, and also includes bounded provenance (`source`, `actionDecisionId`,
action type, conversation type, redacted reason summary, and redacted
`taskPayload`) for audit. This preserves local lookup fields such as safe
conversation labels while redacting secret-like values and platform-like IDs
before durable job persistence.
When `task.type='summary'` and the action target is a group, the same verified
turn-source and governed summary-service rules apply. A model-provided payload
cannot retarget the job or choose a different group/conversation. Other task
types retain the general durable job path above.

## P0 Action Decision Schema

```ts
interface ActionDecision {
  id: string;
  turnId: string;
  createdAt: Date;
  decidedBy: "attention" | "pi" | "evaluator";
  actions: ActionPlan[];
  riskLevel: "low" | "medium" | "high" | "prohibited";
  confidence: number;
  reasons: string[];
  suppressors: string[];
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  evaluatorDecisionId?: string;
  evaluatorPromptId?: string;
}

interface ActionPlan {
  type: ActionType;
  priority: number;
  target?: ActionTarget;
  payload?: ActionPayload;
  reason: string;
  constraints: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    cooldownSeconds?: number;
    maxResponseTokens?: number;
    redactionLevel?: "none" | "light" | "strict";
    capabilities?: string[];
    proactive?: boolean;
    proactiveTrigger?: "user_requested" | "tool_result" | "memory_review" | "safety_or_privacy" | "reminder";
  };
}
```

`actions[]` is a list because social actions are not mutually exclusive.

Base private reply actions preserve both identity channels in their durable
target. `target.userId` is the normalized platform sender ID used for gateway
delivery, while `target.canonicalUserId` is copied from the resolved actor for
governance/audit continuity. Group reply actions keep the group target and do
not copy the group sender into `canonicalUserId` as if it were a DM recipient.
Evaluator-modified actions are re-anchored to locally constructed controls
before durable persistence and execution. The evaluator may change action type,
payload, and reason, and may add or strengthen constraints, but it cannot
retarget a reply/DM, replace the canonical governance identity embedded in the
target, drop evaluator-required status, remove or shorten cooldowns, including through `downgradeAction.cooldownSeconds`, raise
local response-token budgets, lower redaction strictness, clear locally derived
proactive status, or remove locally required capabilities.

For group actions, `SocialDecisionService` marks an intervention proactive when
the inbound event neither mentions the bot nor carries a verified
`reply_to_bot` signal. That value is kept in both
`ActionPlan.constraints.proactive` and `SocialEvaluationRequest.isProactive`;
replying to a human message does not make a bot intervention reactive. Private
and directly addressed group turns are non-proactive. The social evaluator
actor is `group_admin` when the normalized group sender role is owner/admin.

When social evaluation runs, `evaluator_decisions` preserves the structured
request/result identity and `action_decisions.evaluator_decision_id` points to
it. The evaluator row, action decision, and turn link use one repository
transaction, so an action insert failure cannot leave orphan approval evidence.
For model-backed results, the evaluator row also points to one completed
turn-owned `model_invocations` row. The repository validates its request/domain,
ordered sources, configured provider/model/prompt identity, and chronology inside
that transaction. A completed invocation can remain as truthful call evidence if
the later action transaction fails, but it grants no action authority by itself.
Approve, downgrade, reject, and propose outcomes all retain the same evaluator
identity/version/timestamp evidence; low-risk paths keep a null evaluator link.
Evaluator reason text is storage-redacted, while internal IDs, evaluator
version, actor/context, source-event IDs, and timestamps remain exact. The
evaluator reason and each social-action copy derived from it are limited to
2,048 characters including a visible truncation marker. Repository validation
rejects non-social or contradictory evidence and requires the exact turn
trigger plus existing raw-event sources before persistence.
For approve/downgrade outcomes it reconstructs the evaluator-authorized action
from the detached proposed action. Any final non-`silent_store` action must
match that reconstruction exactly. A downgrade must name the proposed action
type in `downgradeAction.from`, and passing `riskLevel="prohibited"` evidence is
invalid. Deterministic cooldown suppression may still replace the whole final
plan with `silent_store` after a valid review.
The evaluator receives a detached request; mutation of that request is detected
after the call and aborts before evaluator or action evidence is written.
If the evaluator invocation itself throws after its invocation ledger has been
terminalized, `SocialDecisionService` converts every proposed action to
`silent_store`, persists `evaluatorRequired=true` and `evaluatorPassed=false`
without an evaluator-decision link, and adds the fixed
`evaluator_terminal_failure` suppressor. Provider diagnostics are not persisted.
This recovery applies only to the invocation failure; returned request mutation
or identity mismatch remains a contract error.

After authority validation and before decision construction, storage redaction,
or execution binding, the action repository guards high-confidence memory
claims in outward `payload.text` and `react_only` `payload.reaction`. Evidence
must match the action's exact turn target and the exact proposition in either a
selected active in-scope memory or a fully committed same-turn
`memory.propose` effect. Proposed memory permits pending-review wording only;
unsupported or ambiguous claims become neutral. A correction adds the fixed
`memory_claim_truthfulness_guard` suppressor to the returned and persisted
decision, so the executor can deliver only the corrected bound payload.

The repository returns a detached decision snapshot and stores a keyed,
versioned commitment to that exact unredacted envelope in
`action_decisions.execution_binding`. The stored action JSON remains redacted
for inspection and is never reloaded as executable input. Creation first clones
the complete caller input, so validation and binding cannot observe different
accessor-backed values. At executor entry, the caller decision is cloned and
synchronously verified against the binding, persisted scalar/redacted fields,
the exact outcome and durable authority metadata of any linked same-turn social
evaluator row, including its model-invocation ID, the bound turn
conversation/trigger, and the turn's current
`action_decision_id` before the first gateway, job, memory, or other awaited
effect. Execution uses only that verified clone and turn source, so
evaluator/action substitution, durable evaluator/turn-row tampering, superseded
decisions, and later caller mutation fail closed. Legacy/null bindings and
bindings created under a different repository instance are not executable.

`suppressors[]` records why an action was downgraded or skipped. This is necessary for tuning and `/why` explanations.

Cooldown suppressors are local control evidence. Repository persistence preserves
valid internal keys such as `cooldown:group:qq-group-12345:reply_short` and the
matching `constraints.cooldownKey` so cooldown debugging and exact owner/admin
lookup keep working. Ordinary narrative suppressor text and action reasons are
still storage-redacted for secret-like and QQ/platform-ID-like substrings before
being written to `action_decisions`. Adjacent secret/platform fragments such as
`sk-...-qq-...` use marker-preserving storage redaction, so both secret and
platform marker classes remain visible without persisting raw values.
Assignment-shaped fragments such as `api_key=sk-...-qq-...` follow the same
marker-preserving rule for action reasons, ordinary suppressors, and structured
action payload keys/values before persistence or owner/admin inspection.

Action execution failures are diagnostics, not ordinary conversation content.
When reply or `dm_user` delivery fails, the executor must redact secret-like and
QQ/platform-ID-like substrings from the returned error and from persisted
`action_executions.error_message`, including platform identifiers embedded after
non-alphanumeric separators in adapter-provided legacy/free-text errors. The
same marker-preserving boundary applies when the adjacent platform fragment is
inside an assignment-shaped secret such as `api_key=sk-...-qq-...`; the
assignment marker and platform marker both remain visible while raw values are
omitted. The
same marker-preserving adjacent secret/platform redaction applies to persisted
execution downgrade reasons, diagnostic codes/messages, and audit entries.
Repository-created `ActionExecutionResult` return values use the same redacted
downgrade reason, diagnostic code/message, and audit-entry strings as the
durable `action_executions` row, so direct callers cannot observe a less
redacted execution result than owner/admin inspection would later display.

The executor is also a final L0 guard for gateway and durable-job side effects.
Direct callers cannot bypass evaluator rejection or prohibited risk by
constructing or substituting an `ActionDecision`: evaluator identity and passing
claims require durable source-bound evidence, every executable decision must
match its repository binding, evaluator-required gateway/job actions are
persisted as `rejected` unless `evaluatorPassed=true`, and
`riskLevel="prohibited"` gateway/job actions are rejected before the gateway
sender or durable job repository is called.
Current `silent_store` actions remain no-op audit/control evidence for rejected
or downgraded paths. `silent_summarize_later` still has no gateway side effect,
but it now requires a durable job repository and schedules a summary job instead
of being a pure no-op, so it is subject to the same prohibited/evaluator final
guard.

Outward actions that deliver a normal message and return an executed message ID
are also responsible for bot-response traceability. Current main turn handling
persists `bot.response` / `bot-self` chat-message evidence for ordinary replies,
`reply_with_tool` successful deliveries, and `send_folded_forward` downgraded
text fallbacks. `react_only` true reactions do not create message evidence, but
a face/text fallback that actually sends a message and returns an executed
message ID is persisted as `bot.response` evidence. The persisted bot-response
text is the actual delivered action `payload.text` after evaluator/tool/fallback
modification; for `react_only` face/text fallback it is the delivered
`payload.reaction`, not merely the raw Pi draft. It does not persist
bot-response rows for failed sends, silent downgrades, or true reaction-only side
effects.

Owner/admin `/why` output labels `react_only` execution effects so true
reaction, face-message fallback, and silent reaction fallback are distinguishable
without inspecting raw gateway logs. The labels are derived from durable
`action_executions` status/message evidence and remain display-redacted.

## Trigger Score and Suppressors

Group chat uses weighted triggers plus suppressors:

```text
message/event
  -> trigger signals add score
  -> unmentioned group question may become a durable delayed candidate
  -> immediate or delayed suppressors downgrade or block outward action
  -> SocialDecisionService constructs an action (with optional evaluator review)
  -> ActionExecutor verifies and executes, or stays silent
```

There is no "must reply" group trigger.

P0 strong triggers:

- `@bot`
- reply-to-bot

Trigger score measures relevance only. No score threshold makes a reply risky:
`@bot`, verified reply-to-bot, and their question combinations remain on the
reply fast path, while an otherwise unaddressed group question is deferred for
durable recheck.

Exact `/memory` and `/why` families are not Attention triggers. After canonical
ingress and identity/display handling, recognized families enter the shared
QQ/CLI governance service before Attention, cooldown, Pi, evaluator, or tools.
The service reparses stored text and revalidates bot-owner or exact-group
owner/admin authority; an unauthorized recognized command receives the fixed
denial. `/memoryless`, `/whyever`, generic `!` prefixes, and narrative
management/settings text remain ordinary input and continue through normal
Attention.

Design-target soft triggers (the current `AttentionEngine` implements the
question signal; the other examples remain future extensions):

- direct question where the bot is likely useful;
- "who remembers..." style questions;
- discussion of bot capabilities;
- watcher/subscription match;
- low-traffic unanswered question;
- bot recently participated in the same thread;
- active task/reminder context.

Design-target suppressors (the fast engine implements `high_speed_chat`; the
durable delayed policy implements expiry, explicit human reply, exact-group
traffic, and exact-group response budget; the other examples remain
policy/context extensions):

- high-speed casual chat;
- emotional conflict;
- sensitive personal topic;
- bot spoke recently;
- several humans are already answering;
- unclear quote target;
- joke thread where explanation would kill the joke;
- message is clearly not addressed to the bot;
- response would leak `private_only` memory;
- response needs high-risk memory;
- response is too long and cannot be folded;
- cooldown/budget hit.

## Durable Delayed Attention

For an unmentioned group question, Attention emits `classification='defer'`
with `recommendedPath='delayed_recheck'`. Initial handling persists the derived
chat row, one source-bound candidate, and its pending `attention_recheck` job in
one immediate SQLite transaction, then completes without creating a turn,
calling Pi, or sending. The job payload is exactly `{ candidateId }`; it never
copies message text.

The policy clock is local ingress time. Candidate `observed_at` equals
`raw_events.created_at` and the matching accepted receipt/admission time, not the
platform message timestamp. Recheck is scheduled for `observed_at + 15s`, and
the thread expires at `observed_at + 120s`.

At recheck, the worker first reconstructs and revalidates the strict stored
event and derives `needs_response` / `reply_fast_path` signals with the
`delayed_recheck` trigger. The service then takes an immediate write lock and
requires current, unexpired job-attempt lease authority before inserting the
candidate's one terminal decision. It chooses the first applicable suppressor:

1. `thread_expired` at the 120-second boundary;
2. `human_answer` when a later human message explicitly replies to the source
   message in the same conversation/group;
3. `high_traffic` for at least six human QQ ingress messages in that exact
   group's rolling 10-second window; or
4. `group_budget_exhausted` after two `respond` decisions for that group in the
   rolling 10-minute window.

A `respond` insert atomically reserves one of those two group slots. The worker
then re-enters the ordinary turn path with the derived signals and without
reinserting the source. Any outward reply remains a proactive group intervention
because the source neither mentions nor replies to the bot; social evaluation
is therefore still required.

Durable completion output is bounded to internal IDs, outcome, suppressor
ID/code pairs, terminal action/turn IDs when applicable, and a local
`deliveryRecorded` flag. A retry reuses the unique Attention decision and any
locally terminal/delivered turn; indeterminate action/delivery evidence fails
closed. This is a local duplicate-send guard, not external exactly-once: a
process failure after QQ accepts a send but before local delivery evidence
commits remains fundamentally ambiguous.

Retention pins the candidate's raw/chat source while its job is `pending` or
`running`. After terminal job state, ordinary source deletion may cascade the
candidate, decision, and suppressors; job and attempt history remains durable.

## Proactive DM

DM does not need a separate subsystem, but it must be a special action in action/policy/audit.

It reuses:

- auth/identity;
- ResponseRouter;
- Gateway Adapter;
- evaluator policy;
- audit log;
- cooldown system.

But `dm_user` must record:

- whether it is proactive;
- trigger kind: `user_requested`, `tool_result`, `memory_review`, `safety_or_privacy`, `reminder`;
- opt-out status;
- redaction level;
- cooldown key;
- audit reason.

Current executor persistence records these fields in bounded
`action_executions.audit_entry` metadata for `dm_user` success, rejection, and
failure paths: `dm_proactive`, `dm_trigger`, `dm_opt_out`,
`dm_redaction_level`, and `dm_cooldown_key`. Free-text reasons and cooldown
keys are redacted before persistence, so secret-like values and
QQ/platform-ID-like fragments are represented only by redaction markers.
`dm_user.target.userId` is the gateway delivery identifier (normalized QQ
platform user ID). Proactive privacy checks use
`dm_user.target.canonicalUserId`; if a proactive DM is evaluated with a privacy
repository but lacks this canonical target, execution is rejected before any
privacy lookup or gateway send and records
`dm_opt_out=missing_canonical_user`.

P0 defaults:

- user-requested DM: allowed;
- tool-result DM: allowed with redaction/evaluator/audit;
- proactive care/prompt DM: allowed with stricter cooldown/evaluator/audit;
- third-party evaluation or group-conflict-triggered DM: default deny or admin digest.

Hard boundaries:

- do not DM someone because a third party evaluated them;
- do not DM someone with psychological judgement from group conflict;
- do not send sensitive group raw text;
- do not expose `private_only` memory;
- respect proactive DM opt-out;
- audit proactive DM.

## Cooldown and Anti-Spam

Cooldown uses budget + suppressor, not simple event dropping:

```text
action candidate
  -> check cooldown / budget
  -> if exceeded: downgrade action
  -> record suppressor
```

Examples:

- `reply_full` -> `reply_short`
- `reply_short` -> `react_only` / `silent_store`
- `dm_user` -> `admin_digest` / `silent_store`
- `reply_with_tool` -> `schedule_background_task` / `dm_user` / `admin_digest`

Current runtime cooldown fields:

- `cooldownKey`
- `cooldownSeconds`

`SocialDecisionService` currently derives a conversation/action-type key for
ordinary replies. `proactive_dm` is an action/policy concept, not a cooldown
field. Named per-group/per-user/per-action-type policy dimensions remain design
targets rather than separate stored fields.

Reserved policy dimensions:

- `per_thread`
- `global_bot`
- `proactive_only`

Cooldown must not prevent raw event/source/memory candidate recording. It only affects outward action.

## Gateway Capabilities: Reaction and Folded Forward

`react_only` is capability-gated.

Preferred behavior:

1. NapCat emoji-like / message emoji reaction (`SetMsgEmojiLike`) when available.
2. Fallback to a QQ `face` message.
3. Fallback to `silent_store`.

A face message is not the same as a true reaction and should consume more cooldown.

`send_folded_forward` is also capability-gated.

Preferred behavior:

1. group/private forward nodes;
2. short summary + private/background details;
3. strictly limited segmented short messages;
4. admin digest or silent.

The Gateway Adapter should expose a capability profile such as:

```ts
interface GatewayCapabilities {
  platform: 'qq';
  reactions: {
    emojiLike: boolean;
    faceMessage: boolean;
  };
  foldedForward: {
    groupForward: boolean;
    privateForward: boolean;
    customNode: boolean;
  };
  platformAdmin: {
    kick: boolean;
    mute: boolean;
    setGroupCard: boolean;
  };
}
```

Reasoning layers output actions. Executors adapt them to platform capabilities.
The current real `OneBotAdapter` reports only implemented delivery capabilities:
QQ face/text reaction fallback is available, true emoji-like reactions and
folded-forward node delivery are not reported as available. Fake gateways can
simulate stronger capabilities for deterministic executor tests.
