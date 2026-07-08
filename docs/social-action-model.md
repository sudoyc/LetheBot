# Social Action Model

LetheBot should not reduce group participation to a boolean "reply or ignore" decision. The attention/evaluator layer outputs structured actions that can be executed, downgraded, combined, or suppressed.

## Action Types

P0 actions:

- `silent_store` — record the event and recent context without replying.
- `silent_summarize_later` — enqueue background summary/memory work without replying.
- `reply_short` — short, low-disruption reply.
- `reply_full` — complete reply for explicit questions, private chat, or low-frequency technical discussion.
- `reply_with_tool` — use a tool and then respond.
- `propose_memory` — create a memory proposal or auto-active decision.
- `admin_digest` — notify owner/admin without disturbing the group.
- `schedule_background_task` — schedule a watcher, summary, reminder, or long task.
- `dm_user` — private-message a user from a group-triggered context.

Schema-reserved / capability-gated actions:

- `react_only` — true reaction if supported, otherwise fallback.
- `send_folded_forward` — folded/merged long reply if supported.

P1 action:

- `ask_clarification` — useful in private chat; cautious in groups.

Actions can be combined. Examples:

- `silent_store + silent_summarize_later`
- `reply_short + propose_memory`
- `reply_with_tool + send_folded_forward`
- `silent_summarize_later + admin_digest`

## P0 Action Decision Schema

```ts
interface ActionDecision {
  actions: ActionPlan[];
  riskLevel: "low" | "medium" | "high" | "prohibited";
  confidence: number;
  reasons: string[];
  suppressors: string[];
}

interface ActionPlan {
  type: ActionType;
  target: ActionTarget;
  priority: number;
  reason: string;
  constraints: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    maxResponseTokens?: number;
    redactionLevel?: "none" | "light" | "strict";
  };
}
```

`actions[]` is a list because social actions are not mutually exclusive.

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

## Trigger Score and Suppressors

Group chat uses weighted triggers plus suppressors:

```text
message/event
  -> trigger signals add score
  -> suppressors downgrade or block outward action
  -> evaluator outputs action
  -> executor acts or stays silent
```

There is no "must reply" group trigger.

P0 strong triggers:

- `@bot`
- reply-to-bot
- command prefix
- owner/admin instruction

Soft triggers:

- direct question where the bot is likely useful;
- "who remembers..." style questions;
- discussion of bot capabilities;
- watcher/subscription match;
- low-traffic unanswered question;
- bot recently participated in the same thread;
- active task/reminder context.

Suppressors:

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

P0 implementation fields:

- `per_group`
- `per_user`
- `per_action_type`
- `proactive_dm`

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
  reaction: {
    emojiLike: boolean;
    faceMessage: boolean;
  };
  foldedForward: {
    groupForward: boolean;
    privateForward: boolean;
    customNode: boolean;
  };
}
```

Reasoning layers output actions. Executors adapt them to platform capabilities.
