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
  -> action executor
  -> audit log / revisions / rollback handles
```

The evaluator may use the same underlying model API as Pi in the MVP, but it must differ in:

- invocation stage;
- prompt and input trimming;
- output schema;
- execution authority;
- audit linkage.

The evaluator can recommend actions. It cannot directly bypass LetheBot service/policy layers or mutate durable state.

## Structured Decisions

Evaluator outputs should be structured records, not free-form permission text.

Common actions include:

- `active`
- `proposal`
- `reject`
- `admin_digest`
- `ask_owner`
- `ask_subject`
- `redact`
- social actions defined in `social-action-model.md`
- tool decisions defined in `tool-registry.md`

Every high-risk structured decision should link to:

- source event IDs;
- actor/context;
- reason summary;
- confidence/risk level;
- evaluator version;
- executor result;
- audit entry.

## L0 Hard Policy

L0 policy is not a question for the LLM to waive during a turn. Owner configuration may change deployment defaults, but such changes must be explicit, auditable, and reversible.

Minimum L0 invariants:

1. `secret` / `prohibited` content does not enter ordinary prompts.
2. `deleted` / `disabled` memory is excluded from retrieval immediately.
3. `private_only` memory is not publicly referenced in group chat by default.
4. Raw QQ IDs, group IDs, and account IDs are operational identity data, not ordinary memory. They may enter prompts when needed for identity disambiguation, platform operations, user-requested ID handling, or debug, but must be purpose-bound, minimal, and structured.
5. Pi, evaluator, and tools do not bypass LetheBot service/policy layers to mutate durable storage.
6. High-risk execution leaves an audit trail.

## Evaluator Policy Toggles

Risk toggles control whether a class of action requires LLM evaluator review. They do not enable or disable the feature itself.

Use this vocabulary:

```yaml
evaluatorPolicy:
  tools:
    sandboxRun:
      evaluator: required # required | bypass
  memory:
    autoActiveLowRisk:
      evaluator: required
  social:
    proactiveGroupReply:
      evaluator: required
```

`evaluator: bypass` means:

- bypass the LLM evaluator for that action class;
- still enforce L0 hard policy;
- still enforce permissions;
- still execute through the action executor;
- still apply audit/sandbox policy where required.

Do not model evaluator policy as `enabled: true | false`. Feature availability belongs to installation/configuration, not risk review.

## Policy Groups

The initial policy groups are:

- `tools` — tool execution, sandbox, network, file writes, long-running jobs.
- `memory` — automatic active memory, cross-scope injection, memory edits/supersede.
- `social` — proactive group replies, proactive DM, sensitive topic replies, private-memory mentions.

A global unsafe mode is intentionally avoided. Different risk surfaces need separate controls.

## Memory Auto-Active Governance

Memory auto-active is agent-mediated:

```text
memory candidate
  -> L0 hard filter
  -> evaluator / risk classifier
  -> structured decision
  -> policy/action executor
  -> memory_records + sources + revisions + audit log
```

Default risk handling:

- low risk: evaluator may auto-active;
- medium risk: evaluator may auto-active only with conservative visibility such as `private_only`, `same_group_only`, or `owner_admin_only`;
- high risk: proposal or admin digest;
- secret/prohibited: reject or redact, never active.

Auto-active records must be reversible through memory revisions and excluded from retrieval immediately when disabled/deleted.

## Audit and Rollback

Governance decisions must be explainable after the fact.

For memory and high-risk actions, store:

- previous state;
- new state;
- evaluator decision ID;
- source IDs;
- reason;
- actor/executor;
- timestamp.

Conflicting memory should use `superseded` state or a revision rather than silent overwrite.

Ordinary `/why` explanations should be redacted to the current user's visibility. Owner/admin CLI can show fuller traces.