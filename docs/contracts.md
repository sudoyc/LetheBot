# Contracts

This document defines the TypeScript interfaces and data schemas that form the contracts between LetheBot's modules. These are the "cannot guess" boundaries for implementation.

**Status:** Architecture contract reference. Current TypeScript types,
repositories, migrations, and tests are authoritative for exact implemented
field names; the ownership boundaries here remain normative.

## Design Principles

1. **Explicit over implicit:** Every boundary has a typed interface.
2. **Append-only event sourcing:** Raw events are append-only while retained, and action decisions are append-only.
3. **Separation of concerns:** Gateway doesn't know about memory; Pi doesn't write directly to storage.
4. **Testability:** Every interface can be mocked or faked.

---

## 1. Event Envelopes

### 1.1 Base Internal Event

All internal events extend this:

```typescript
interface InternalEvent {
  id: string;  // ULID
  type: string;  // discriminator
  timestamp: Date;
  source: 'gateway' | 'agent' | 'tool' | 'worker' | 'system';
  platform?: 'qq';
  conversationId?: string;  // opaque conversation identifier
  correlationId?: string;  // ties related events together
}
```

### 1.2 Chat Message Received

```typescript
interface ChatMessageReceived extends InternalEvent {
  type: 'chat.message.received';
  source: 'gateway';
  platform: 'qq';

  ingress: {
    transport: 'http' | 'ws';
    platformEventId?: string;
  };

  message: {
    messageId: string;  // platform message ID
    conversationId: string;
    conversationType: 'private' | 'group';

    groupId?: string;  // if group
    senderId: string;  // platform user ID
    senderRole?: 'member' | 'admin' | 'owner';
    senderDisplayName?: string;
    senderCard?: string;

    content: {
      text?: string;
      media?: MediaAttachment[];
      quote?: QuotedMessage;
    };

    mentions?: string[];  // platform user IDs
    mentionsBot: boolean;
    replyToMessageId?: string;
  };

  // Gateway capability report
  gatewayCapabilities: GatewayCapabilities;
}

interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  localPath?: string;
  mimeType?: string;
  size?: number;
}

interface QuotedMessage {
  messageId: string;
  senderId: string;
  text?: string;
}
```

For a valid normalized OneBot `message_id`, ingestion claims one canonical raw
event by `(platform, type, conversationId, platformEventId)`. Conversation is
part of the key and transport is not: the same message ID in another
conversation is distinct, while HTTP and WebSocket deliveries of the same key
deduplicate. Missing, malformed, or wrong-namespace message IDs use a bounded
local `messageId` and omit `platformEventId`; those deliveries have no
cross-delivery deduplication guarantee.

The first successful claimant owns the stored normalized payload, event
timestamp, internal event ID, and payload-level ingress transport. A retry with
changed content never overwrites that canonical row. The claim transaction also
appends an `accepted` receipt and creates one `event_processing_admissions` row
in `accepted` state. Later matching deliveries append `duplicate` receipts
linked to the same raw event and record their actual transport and receipt time;
they never create or repair an admission. Only a new accepted claim is enqueued
for downstream identity, chat, turn, action, and delivery work. Any failure to
write the raw event, accepted receipt, or admission rolls back all three.

An accepted receipt proves the canonical claim committed, not that asynchronous
turn processing completed. The admission moves through
`accepted -> processing -> completed|failed`; inactive-account and silent paths
still end as `completed`. The compare-and-set transition to `processing` occurs
before identity, derived chat, turn, Pi, tool, action, or send work. Ignored
packets and failed claim transactions create no receipt or admission. HTTP
accepted and duplicate deliveries return the bounded success response; a claim
transaction failure returns bounded HTTP 503 and can be retried after the
underlying fault is fixed. WebSocket duplicates have no outbound response side
effect.

At startup, ingress remains closed while the application reconciles the ledger
and waits for the configured gateway transport to become ready. It rehydrates
and strictly validates the stored normalized event, including its ISO
timestamp, raw-row identity fields, and matching accepted receipt. A valid
`accepted` row with no chat, turn, or event-failure evidence can be claimed once
and replayed. A `processing` row is eligible only when a fresh read under an
immediate SQLite transaction proves the same strict event validity, exactly one
matching accepted receipt, and no chat, trigger-turn, or event-failure evidence.
A guarded compare-and-set then resets it to the canonical `accepted` shape; only
the single winning reset is queued for replay. Malformed or contradictory
accepted rows and ineligible processing rows that still remain `processing`
become `interrupted_review`; a reset that loses to another state transition is
never enqueued and that newer state is left untouched. In the same SQLite
transaction, linked `pending`/`running` turns become `aborted`, receive a bounded
recovery marker and `completed_at`, while completed/failed/aborted turns and
context/action/execution/bot-response evidence remain unchanged. If the turn
update fails, the admission transition rolls back. Terminal admissions and
legacy raw rows without admissions remain inert. Startup reconciliation assumes
the previous application process is stopped; it is not a multi-instance lease
or ownership protocol.

Graceful application shutdown closes ingress admission before draining work.
An HTTP event whose request body completes after admission closes receives the
same bounded 503 and creates no raw event or receipt; WebSocket ingress receives
a failed disposition and is not claimed. Already accepted event tasks and
already started scheduler handlers are awaited while the gateway remains
available for outbound completion. HTTP listener close, scheduler drain, and
event-task drain start together; the gateway and SQLite connection close only
after all three settle. Repeated stop requests share one shutdown sequence.
There is intentionally no timer that closes SQLite under unresolved work. After
a supervisor hard kill, a `processing` admission with any
chat, turn, or failure evidence remains delivery/effect-unknown and startup
quarantines it instead of risking a duplicate external effect. Automatic
recovery is limited to valid `accepted` work and guarded-reset processing work
that is proved evidence-empty.

The `raw_events.payload` for this path is the normalized internal event, not the
original OneBot wire object. Deduplication lasts only while the canonical raw
row exists; explicit retention may delete unpinned raw rows and cascade their
receipts and terminal admission, after which the same platform key can be
accepted again. `accepted` and `processing` admissions pin their raw row until
they reach a terminal state. A `pending` or `running` delayed-Attention job also
pins its candidate's raw/chat source; terminal jobs release that retention
guard.

Unsupported OneBot inbound post types such as `notice`, `request`,
`meta_event`, `message_sent`, and unknown/future post types such as
`message_reaction` are acknowledged at the HTTP boundary but do not currently
produce `chat.message.received` internal events. They must not create raw-event,
chat-message, turn, context-trace, action-decision, or action-execution rows,
call Pi, send outbound messages, record event-processing failures, or persist
secret-like/platform-like fields through the chat path. Add explicit contracts
before enabling durable handling for a new non-message event type, self-sent
echo type, or future OneBot extension event.

Reverse HTTP payloads that are valid JSON but not JSON objects, such as
`null`, arrays, strings, numbers, or booleans, are also acknowledged at the HTTP
boundary but ignored before OneBot event conversion. They must not create
chat-path durable rows, emit internal chat events, call Pi, send outbound
messages, record event-processing failures, or poison adapter readiness
diagnostics with payload-derived values.

OneBot WebSocket inbound packets that parse as valid JSON but are not JSON
objects, such as `null`, arrays, strings, numbers, or booleans, are ignored
before pending-response resolution or OneBot event conversion. They must not
emit internal chat events, emit adapter errors, poison readiness diagnostics,
create additional outbound WebSocket sends, or resolve/remove unrelated pending
WebSocket API requests.

OneBot WebSocket inbound object packets that do not resolve a pending `echo`
and do not contain a supported `post_type: "message"` event are also ignored
without side effects. Unmatched `echo` values, API-shaped objects without an
`echo`, non-string `post_type` values, and unsupported/future OneBot post types
must not emit internal chat events, emit adapter errors, poison readiness
diagnostics, create additional outbound WebSocket sends, or resolve/remove
unrelated pending WebSocket API requests. Add an explicit durable contract
before enabling WebSocket handling for a new non-message event type or future
OneBot extension packet.

When a WebSocket object packet contains a string `post_type`, it is classified
as an inbound OneBot event before pending API-response matching. An event packet
that also carries an `echo` field, even one equal to a currently pending API
request, must not resolve or remove that pending request. The event path should
emit or ignore the packet according to the OneBot event contract, and the
pending API request must remain pending until a non-event response object with
the matching `echo` arrives.

OneBot WebSocket inbound `post_type: "message"` packets with unsupported or
malformed `message_type` values are ignored before internal chat-event emission.
Unsupported values such as `guild`, empty strings, non-string values, `null`, or
missing `message_type` fields must not emit internal chat events, emit adapter
errors, poison readiness diagnostics, create additional outbound WebSocket
sends, leak packet-derived secret-like/platform-like fragments through
readiness, or resolve/remove unrelated pending WebSocket API requests. The
pending WebSocket API request must still resolve only when its matching `echo`
response object arrives.

Malformed reverse HTTP JSON bodies are rejected with HTTP 400 and a bounded
`{ "error": "Invalid JSON" }` response. They must not echo request body content,
create chat-path durable rows, emit internal chat events, call Pi, send outbound
messages, record event-processing failures, or persist secret-like/platform-like
body fragments through the chat path.

OneBot `post_type: "message"` payloads with unsupported `message_type` values
are also acknowledged at the HTTP boundary but must not be coerced into private
or group chat events. They must not create raw-event, chat-message, turn,
context-trace, action-decision, or action-execution rows, call Pi, send outbound
messages, record event-processing failures, or persist secret-like/platform-like
fields through the chat path.

For supported OneBot `message_type: "private"` or `"group"` payloads, optional
`sub_type` is a bounded protocol classifier, not message content. Omitted or
`null` subtypes are treated as unspecified. Supported private subtypes are
`friend`, `group`, `group_self`, and `other`; supported group subtypes are
`normal`, `anonymous`, and `notice`. Unsupported, empty, or malformed
`sub_type` values are acknowledged at the HTTP boundary and ignored before
internal chat-event emission. They must not create raw-event, chat-message,
turn, context-trace, action-decision, or action-execution rows, call Pi, send
outbound messages, record event-processing failures, poison readiness
diagnostics, or persist secret-like/platform-like fields through the chat path.
The same boundary applies to WebSocket message packets, and unmatched pending
WebSocket API requests must remain pending until their matching `echo` response
arrives.

For supported OneBot `message_type: "private"` or `"group"` payloads, the
top-level `message` field is parsed only when it is a CQ string or a segment
array. If `message` is a malformed scalar/object/null and `raw_message` is also
not a string, the gateway must degrade to an empty normalized message body
rather than throwing adapter diagnostics or stringifying raw objects. This path
still writes normal raw/chat rows for the received event, but must not create
mentions, quotes, media, bot-trigger, Pi, context, action, outbound-message, or
event-processing-failure side effects, and must not persist secret-like or
platform-like fragments from malformed `message` / `raw_message` containers.
The WebSocket ingress path follows the same normalization boundary for
supported private/group packets and additionally must not poison readiness,
create extra outbound WebSocket sends, or resolve/remove unrelated pending
WebSocket API requests.

Gateway adapters must normalize platform-provided identifiers before emitting
this internal event. For OneBot/QQ top-level `message_id`, `user_id`, and
`group_id`, accept positive safe-integer numeric values, numeric strings, or
already-normalized `qq-<digits>` / `qq-group-<digits>` strings. Other top-level
string/object/array/boolean identifier shapes, including negative or fractional
numeric IDs, are malformed input and must fall back to bounded local or
`unknown` identifiers rather than being persisted as synthetic platform IDs. The
WebSocket ingress path follows the same top-level identifier boundary for
supported private/group packets and additionally must not poison readiness,
create extra outbound WebSocket sends, leak malformed identifier fragments
through emitted events/readiness, or resolve/remove unrelated pending WebSocket
API requests.

Downstream ingestion, context traces, memory visibility checks, and Pi/tool
policy context use the gateway-normalized group identifier (`qq-group-<digits>`)
without stripping the prefix. This keeps durable `chat_messages.group_id`,
`context_traces.group_id`, display-profile `source_group_id`, and tool
`allowedGroupIds` / `deniedGroupIds` policy values comparable by exact string.

For OneBot top-level `time`, accept only finite numeric Unix seconds and convert
them to internal `Date` timestamps. Malformed string/object/array/boolean/null,
`NaN`, and `Infinity` values must fall back to the receipt-time window rather
than being coerced into historical/future timestamps or persisted as raw
protocol time. The WebSocket ingress path follows the same timestamp boundary
for supported private/group packets and additionally must not poison readiness,
create extra outbound WebSocket sends, leak malformed timestamp fragments
through emitted events/readiness, or resolve/remove unrelated pending WebSocket
API requests.

For OneBot CQ-string and segment-array metadata, `at.qq` and `reply.id` are
separate bounded identifier channels. `at.qq` accepts positive safe-integer
numeric values, numeric strings, already-normalized `qq-<digits>` user IDs, and
the literal group-wide `all` / `qq-all` mention marker; it must not treat
arbitrary strings as synthetic user IDs. `reply.id` accepts positive
safe-integer numeric values, numeric strings, already-normalized `qq-<digits>`
message IDs, and internal
`qq-bot-<digits>` bot-response message IDs used by the local fake/action path;
other string/object/array/boolean identifier shapes are malformed and must not
create mention, quote, reply-to, or bot-trigger side effects.

Malformed OneBot segment-array entries, such as primitives, arrays, `null`, or
objects without a string `type`, are ignored. Supported segment types with
non-object `data` containers are handled as empty data rather than trusted
metadata. The WebSocket ingress path follows the same segment-array boundary for
supported private/group packets and additionally must not poison readiness,
create extra outbound WebSocket sends, leak malformed segment fragments through
emitted events/readiness, or resolve/remove unrelated pending WebSocket API
requests.

OneBot media metadata preserves media presence separately from media URLs. Valid
string `url` values are preserved only when they do not contain secret-like or
QQ/platform-ID-like substrings. If URL redaction would be required, the adapter
drops the `url` field and keeps the media `type`, so normalized raw-event
metadata can still record that media existed without storing private download
tokens or platform identifiers. The WebSocket ingress path follows the same
media URL boundary for supported private/group CQ-string and segment-array
packets and additionally must not poison readiness, create extra outbound
WebSocket sends, leak sensitive media URL fragments through emitted
events/readiness, or resolve/remove unrelated pending WebSocket API requests.

OneBot sender display metadata (`sender.nickname` and group `sender.card`) is
untrusted UI metadata, not an identity authority or prompt instruction. Gateway
normalization must preserve ordinary display text, but secret-like and
QQ/platform-ID-like substrings are redacted before the internal
`ChatMessageReceived` event is emitted. This keeps normalized `raw_events`
payloads, display-profile persistence, and prompt-visible recent-message
metadata on the same redaction boundary. The WebSocket ingress path follows the
same display-metadata boundary for supported private/group packets and
additionally must not poison readiness, create extra outbound WebSocket sends,
leak malformed or sensitive display fragments through emitted events/readiness,
or resolve/remove unrelated pending WebSocket API requests.

For OneBot outbound send API responses, `data.message_id` is another bounded
identifier channel. Accept positive safe-integer numeric values, numeric
strings, and already-normalized `qq-<digits>` message IDs. Other
string/object/array/boolean shapes, including negative or fractional numeric
IDs, are malformed and must fall back to a bounded local `qq-sent-*` ID rather
than being returned to action execution as a synthetic platform message ID.

For OneBot outbound send targets, `send_private_msg.user_id` and
`send_group_msg.group_id` must be derived only from positive safe-integer QQ
identifiers. Zero, unsafe integer strings, and malformed target identifiers
must be rejected before any HTTP/WebSocket send call is attempted; bounded
errors must not echo raw target values.

OneBot send API error diagnostics are display/readiness data, not governed
platform identifiers. HTTP and WebSocket send response `message` / `wording`
fields, request exceptions, and adapter `lastError` values must redact
secret-like and QQ/platform-ID-like substrings before being thrown or exposed by
gateway readiness. WebSocket lifecycle diagnostics follow the same boundary:
open-factory failures, socket `error` events, socket close reasons, invalid JSON
parse diagnostics, and emitted adapter `error` events must be redacted before
readiness or listener exposure. WebSocket close while send API requests are
pending must reject those pending requests with bounded local diagnostics and
clear readiness `pendingWsRequests` without exposing raw close reasons. Adapter
shutdown must preserve the same pending-request cleanup boundary even if the
underlying socket close operation fails. If `socket.send()` throws after a
pending request is created, the adapter must clear that pending request, redact
the caller/readiness diagnostic, and avoid unhandled internal promise
rejections.

WebSocket lifecycle callbacks are owned by the socket that registered them.
Only the current socket may change readiness, resolve/reject pending requests,
or dispatch ingress; stale `open`, `message`, `error`, and `close` callbacks from
a stopped or superseded socket are ignored. An unexpected close of the current
socket schedules one fixed-delay replacement, while adapter stop cancels the
timer. Pending sends reject on their current connection loss and are not
replayed automatically because delivery may already have occurred.

### 1.3 Gateway Capabilities

```typescript
interface GatewayCapabilities {
  platform: 'qq';

  reactions: {
    emojiLike: boolean;  // true emoji reaction support
    faceMessage: boolean;  // fallback to QQ face message
  };

  foldedForward: {
    groupForward: boolean;  // group forward node
    privateForward: boolean;  // private forward node
    customNode: boolean;  // custom text node
  };

  platformAdmin: {
    kick: boolean;
    mute: boolean;
    setGroupCard: boolean;
  };
}
```

Current real `OneBotAdapter` capability reports are conservative and must match
implemented gateway side effects: `reactions.emojiLike=false`,
`reactions.faceMessage=true`, and all `foldedForward` fields are `false` until
real OneBot/NapCat folded-forward node APIs are wired. Fake gateways may expose
stronger capabilities only for deterministic executor tests.

---

## 2. Identity & Display

### 2.1 Platform Account Mapping

```typescript
interface PlatformAccountMapping {
  platform: 'qq';
  platformAccountId: string;  // raw QQ user ID
  canonicalUserId: string;  // internal UUID/ULID

  accountType: 'private' | 'group_member' | 'temp_session';
  verifiedLevel: 'observed' | 'self_claimed' | 'owner_verified';
  status: 'active' | 'disabled' | 'deleted';

  firstSeenAt: Date;
  lastSeenAt: Date;
}
```

Canonical identity resolution uses only `status=active` mappings. Repository
inspection may return disabled/deleted mappings so callers can distinguish an
inactive tombstone from an account that has never been observed; create-or-get
helpers must create only when no row exists and must not reactivate an inactive
row. First-seen create-or-get is one immediate transaction with read-winner
semantics, so concurrent events cannot return different canonical users for one
platform account. Explicit mapping creation is insert-only. Automatic resolution
may refresh timestamps only for an active mapping; neither path can change its
canonical owner, verification metadata, or lifecycle state. Runtime events from
inactive mappings retain the raw ingress claim and
receipt but stop before display metadata, chat-message, turn, context, Pi,
action, or memory-extraction work.

### 2.2 Display Profile

```typescript
interface DisplayProfile {
  canonicalUserId: string;

  // Current display (not history)
  currentDisplayName: string;
  sourceGroupId?: string;  // null = private/global nickname
  observedAt: Date;

  // Trust level for display data
  trust: 'platform_provided' | 'user_set' | 'inferred';
}

// Nickname history is separate table, not in main DisplayProfile
interface NicknameHistoryEntry {
  canonicalUserId: string;
  displayName: string;
  sourceGroupId?: string;
  observedAt: Date;
  observedUntil?: Date;
}
```

---

## 3. Context Pack

### 3.1 Context Pack

```typescript
interface MemorySelectionEvidence {
  memoryId: string;
  querySources: Array<'current_message' | 'quoted_message' | 'recent_thread'>;
  retrievalMethods: Array<'scoped_rank' | 'fts'>;
  scopeAffinity: 'exact_conversation' | 'exact_group' | 'same_user' | 'global';
  retrievalRank: number;  // positive, 1-based final candidate order
  selectionReason: 'profile_priority' | 'query_match' | 'ranked_fallback';
}

interface ContextPack {
  id: string;  // ULID
  turnId: string;  // ties to agent_turns
  createdAt: Date;

  conversation: {
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  };

  // Recent messages (token-budgeted)
  recentMessages: RecentMessage[];
  currentMessageRef?: MessageRef;
  replyReference?: ReplyReference;

  // Memory (visibility-filtered)
  memory: {
    userProfile?: MemoryBlock;
    groupProfile?: MemoryBlock;
    retrievedFacts: MemoryBlock[];
    selectedMemoryIds: string[];  // for audit
  };

  // Participant context (minimal)
  participants: ParticipantContext[];

  // Injected identity fields (for audit)
  injectedIdentityFields: string[];  // e.g., ['current_display_name', 'sender_role']
  injectedIdentityData?: Array<{ name: string; value: string }>;

  // Retrieval/injection trace (not necessarily rendered into the prompt)
  trace?: {
    candidateMemoryIds: string[];
    selectedMemoryIds: string[];
    rejectedMemories: Array<{ memoryId: string; reason: string }>;
    memorySelections?: MemorySelectionEvidence[];
    filtersApplied: string[];
  };

  // Token budget tracking
  tokenBudget: {
    max: number;
    used: number;
    breakdown: {
      recentMessages: number;
      memory: number;
      identity: number;
      system: number;
    };
    promptLayers?: Array<{ name: string; version: string; tokens: number }>;
  };
}

interface RecentMessage {
  messageId: string;
  senderId: string;
  senderDisplayName: string;  // for rendering, not identity
  text?: string;
  timestamp: Date;
  isFromBot: boolean;
  senderRole?: 'member' | 'admin' | 'owner';

  // Assigned after token-budget selection; opaque and local to this pack.
  messageRef?: MessageRef;
  speakerRef?: SpeakerRef;
  isCurrent?: boolean;
}

type MessageRef = `message_${number}`;
type SpeakerRef = `speaker_${number}`;

interface ReplyReference {
  status: 'resolved' | 'unresolved';
  sourceMessageRef: MessageRef;
  targetMessageRef?: MessageRef;
  targetSpeakerRef?: SpeakerRef;
  targetRole?: 'human' | 'bot';
  targetInRollingWindow?: boolean;
}

interface MemoryBlock {
  id?: string;  // compatibility alias
  memoryId: string;
  scope: string;
  kind?: 'preference' | 'fact' | 'constraint' | 'summary' | 'reflection' | 'procedure';
  title: string;
  content: string;
  confidence: number;
  sourceContext?: string;
}

interface ParticipantContext {
  canonicalUserId?: string;
  speakerRef?: SpeakerRef;

  // Display (untrusted user-provided data)
  displayName: string;
  groupCard?: string;
  role?: 'member' | 'admin' | 'owner';

  // Flags (for policy)
  isOwner: boolean;
  isAdmin: boolean;
  isTrusted: boolean;

  // Platform ID injection (purpose-bound)
  platformAccountId?: string;  // only if needed for identity disambiguation/debug
}
```

---

## 4. Action Decision & Execution

### 4.1 Action Decision

```typescript
interface ActionDecision {
  id: string;  // ULID
  turnId: string;
  createdAt: Date;

  decidedBy: 'attention' | 'pi' | 'evaluator';

  actions: ActionPlan[];
  riskLevel: 'low' | 'medium' | 'high' | 'prohibited';
  confidence: number;  // 0.0 - 1.0

  reasons: string[];  // why these actions
  suppressors: string[];  // what downgraded/blocked actions

  // Evaluator metadata (if applicable)
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

  constraints: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    cooldownSeconds?: number;
    maxResponseTokens?: number;
    redactionLevel?: 'none' | 'light' | 'strict';
    capabilities?: string[];  // required gateway capabilities
    proactive?: boolean;
    proactiveTrigger?: 'user_requested' | 'tool_result' | 'memory_review' | 'safety_or_privacy' | 'reminder';
  };

  reason: string;
}

type ActionType =
  | 'silent_store'
  | 'silent_summarize_later'
  | 'reply_short'
  | 'reply_full'
  | 'reply_with_tool'
  | 'propose_memory'
  | 'admin_digest'
  | 'schedule_background_task'
  | 'dm_user'
  | 'react_only'
  | 'send_folded_forward'
  | 'ask_clarification';

interface ActionTarget {
  conversationId: string;
  conversationType: 'private' | 'group';
  userId?: string;  // platform delivery user ID for private replies / dm_user
  canonicalUserId?: string;  // canonical user ID for privacy/governance checks
  groupId?: string;
}

type BackgroundTaskActionType =
  | 'summary'
  | 'extraction'
  | 'consolidation'
  | 'decay'
  | 'conflict'
  | 'admin_digest'
  | 'retention';

interface BackgroundTaskActionRequest {
  type: BackgroundTaskActionType;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  scheduledAt?: number | Date;
  maxAttempts?: number;
}

interface AutomaticExtractionTaskPayload {
  sourceChatMessageId: string;  // canonical chat_messages.id
  targetUserId: string;         // canonical user ID, not a platform account ID
}

interface DelayedAttentionTaskPayload {
  candidateId: string;          // exact one-key internal worker payload
}

interface GroupSummaryTaskPayload {
  conversationId: string;
  conversationType: 'group';
  groupId: string;
  windowVersion: 1;
  sourceChatMessageIds: string[]; // ordered, unique, 1..50 post-budget chat IDs
  candidateCount: number;         // eligible pre-budget candidate count
}

interface MemoryProposalRequest {
  scope: 'user' | 'group' | 'conversation' | 'global';
  canonicalUserId?: string; // required for user scope
  groupId?: string;         // required for group scope unless target.groupId exists
  kind: 'preference' | 'fact' | 'constraint' | 'summary' | 'reflection' | 'procedure';
  title: string;
  content: string;
  confidence: number;       // 0.0 - 1.0
  sourceContext: string;    // action executor does not persist this raw value
}

interface ActionPayload {
  text?: string;
  toolCall?: ToolCallRequest;
  memoryProposal?: MemoryProposalRequest;
  backgroundTask?: BackgroundTaskActionRequest;
  reaction?: string;
  messageId?: string;  // target message for react_only
}
```

`attention_recheck` is a known internal durable worker type with the exact
`DelayedAttentionTaskPayload` shape. It is deliberately absent from
`BackgroundTaskActionType`: ordinary action plans cannot manufacture delayed
Attention work; only the source-bound Attention admission path may create it.

`ActionDecision` intentionally exposes no reusable execution token. Creation
returns a detached snapshot and stores a process-keyed HMAC commitment in the
durable action row. The commitment covers the exact evaluator outcome and its
durable request ID, version, actor/context, source-event list, timestamps,
domain, turn, risk, and confidence metadata, plus the turn's conversation and
trigger event. Creation snapshots the complete input before authority
validation. `ActionExecutor` clones and verifies that full envelope, the
persisted/evaluator evidence, and the turn's current `action_decision_id`
synchronously before its first awaited effect, then uses only the verified clone
and verified turn source. Redacted `action_decisions.actions` is not an
executable serialization. Superseded decisions, null legacy bindings, and
bindings from another repository/process are inspection-only and fail closed.

After turn and evaluator authority validation, action-decision creation applies
the deterministic memory-claim guard before constructing, redacting, binding,
or persisting the decision. Durable-memory wording is supported only by the
exact proposition in a currently active, in-scope memory selected by this
turn's ContextTrace. A fully committed same-turn `memory.propose` effect may be
described only as pending review. Missing, failed, unrelated, unselected,
inactive, ambiguous, or target-mismatched evidence produces neutral wording and
adds the fixed `memory_claim_truthfulness_guard` suppressor. A planned action is
not evidence of an effect, and this guard does not mutate memory state.

Automatic extraction stores only `AutomaticExtractionTaskPayload` in the
durable job. A deterministic candidate check commits that job with the canonical
inbound chat row in one local transaction before Attention can return or later
Pi/action/send work can fail. The handler reloads text, conversation type/group,
and timestamp from that row, verifies that its current active platform-account
mapping resolves to `targetUserId`, and rejects bot/non-gateway or mismatched
sources. It never trusts copied user/bot text in the job payload. For group
sources, the worker reapplies the same bounded exact pattern set as admission so
nested reports, hypotheticals, wants, or needs cannot become a broader secondary
match. Bot-response persistence and successful turn completion form a later
separate local transaction. Pending/running automatic extraction jobs pin their
source chat row against retention until the job becomes terminal or durable
memory provenance takes over.

For `dm_user`, `ActionTarget.userId` is the gateway delivery identifier (for
OneBot/QQ, the normalized platform user ID such as `qq-<digits>`). Privacy and
governance checks must use `ActionTarget.canonicalUserId` instead. A proactive
`dm_user` cannot satisfy proactive-DM opt-out enforcement by looking up the
platform delivery ID as if it were the canonical user ID.

`SocialDecisionService` uses the same identity split for base private reply
actions. Private action targets persisted in `action_decisions.actions` carry
the platform sender ID in `target.userId` for gateway delivery and the actor's
canonical user ID in `target.canonicalUserId` for governance/audit continuity.
Group reply targets keep `target.groupId` and do not treat the group sender as a
DM delivery target.
For social evaluation, an outbound group intervention is proactive when the
inbound event neither mentions the bot nor has a verified `reply_to_bot`
Attention signal. The same boolean is stored in the locally constructed action
constraint and evaluator request; a raw reply-to-message field targeting a
human does not make the intervention reactive. Private turns and directly
addressed group turns are non-proactive. Normalized group owner/admin roles are
represented as `group_admin` in social evaluator actor evidence.
Evaluator `modifiedAction` output may change the action type, payload, and
reason, and may add or strengthen constraints, but it must not replace the
locally constructed `ActionTarget` or weaken locally derived control
constraints. The service re-anchors modified actions to the original target and
merges constraints before persistence so model/evaluator output cannot retarget
delivery, swap canonical governance identity, drop evaluator-required status,
remove or shorten cooldowns, including through `downgradeAction.cooldownSeconds`,
clear a locally derived proactive marker, raise local response-token budgets,
lower redaction strictness, or remove locally required capabilities.
The structured evaluator result reason and social-action narrative copies
derived from it are storage-redacted and bounded to 2,048 characters including
the truncation marker. Evaluated action persistence also requires social
request/result domains, coherent passed/risk/confidence metadata, the turn's
trigger event in `sourceEventIds`, and existing raw-event sources. A passing
result must reconstruct the final non-`silent_store` action exactly from the
reviewed proposed action plus the evaluator modification/downgrade. Downgrade
results require a matching `downgradeAction.from`, and a passing result cannot
claim `riskLevel="prohibited"`. A final all-`silent_store` plan remains allowed
when deterministic cooldown suppression removes the reviewed outward action.

`admin_digest` actions are executed by scheduling a durable `admin_digest` job;
the execution result links the `action_executions` row to `jobs` through
`executed.jobId` / `executed_job_id` instead of sending a gateway message.
The generated `action:admin_digest:<decisionId>` idempotency key is preserved
for single actions and receives a deterministic `:actionN` suffix only when one
decision contains multiple `admin_digest` durable-job actions.
`propose_memory` actions are executed by creating a governed proposed memory
through `MemoryRepository.create`; they do not auto-activate memory and do not
send a gateway message. The executor requires a traceable turn source, links the
new memory to the triggering `raw_event`, persists
`action_executions.executed_memory_id`, and returns `executed.memoryId`.
Secret/prohibited content is rejected by deterministic memory policy before any
memory row is written. User-scoped proposals also honor
`memory_association=opted_out` during action execution: the executor rejects the
action before source lookup or memory creation and records a rejected
`action_executions` row whose rejection evidence does not copy candidate
content.
`silent_summarize_later` actions are executed by scheduling a durable `summary`
job and perform no gateway send. Private summaries use the generated
`action:silent_summarize_later:<decisionId>:summary` idempotency, with a
deterministic `:actionN` suffix only for duplicate actions in the same generated
durable-job idempotency group. The execution result links through
`executed.jobId` / `executed_job_id`. The stored job payload contains bounded
action provenance, target conversation fields, and a redacted reason summary
rather than raw prompt/action payload text. Because this is durable job
scheduling rather than a pure no-op, prohibited or evaluator-unapproved
decisions are rejected before any `jobs` row is created.
For group targets, the action target must also equal the verified triggering
chat row's exact conversation and group. A single governed summary job service
checks the enabled policy, strips caller-supplied scope/window fields, plans the
canonical local-ingress window, and freezes `GroupSummaryTaskPayload`. Mutable
`messageRange` / `timeRange` fields are not authoritative for group jobs. One
valid pending/running exact-scope window is reused before replanning. Otherwise
the service derives `summary:group-window:v1:*` from group/conversation scope,
policy generation, and the ordered sources; route-specific caller keys do not
control group idempotency. Policy and source revalidation plus the `jobs` and
`group_summary_job_bindings` inserts are atomic. Sources already governed by a
summary or reserved by an existing frozen window, including a terminally failed
one, cannot overlap.
Private summary jobs remain unbound. Missing, contradictory, cross-group, or
ambiguous trigger scope fails before job creation.
`schedule_background_task` actions follow the same durable-job linkage for
known local task types (`summary`, `extraction`, `consolidation`, `decay`,
`conflict`, `admin_digest`, and `retention`): the executor writes a generated
`action:schedule_background_task:<decisionId>:<taskType>` idempotency key,
preserving that backward-compatible key for single actions and appending
`:action1`, `:action2`, ... only for duplicate same-type durable jobs inside one
decision for non-group tasks and private summaries. The executor persists
redacted worker-consumable task fields at top level plus bounded audit provenance
and `taskPayload`, and ignores any raw action-provided idempotency key so secrets
or platform IDs do not become durable job lookup keys.
Its group `summary` variant uses the same exact trigger-source, frozen-window,
and policy-bound service as discovery and `silent_summarize_later`. The handler
parses a nonempty, unique, bounded frozen list before Provider access. Execution
rejects missing, reordered, cross-scope, pre-epoch, or ContextBuilder-omitted
sources, and later rows cannot enter the window. The matching binding, enabled
generation, and current unexpired job-attempt authority are checked around
Provider use; the exact snapshot is reread before the governed write. Final
FK-backed `memory_sources` equals the frozen set. Deterministic policy/binding
failures are non-retryable job failures.

### 4.2 Action Execution Result

```typescript
interface ActionExecutionResult {
  id: string;  // ULID
  actionDecisionId: string;
  actionType: ActionType;
  executedAt: Date;

  status: 'success' | 'downgraded' | 'failed' | 'rejected';

  // What actually happened
  executed?: {
    messageId?: string;
    dmMessageId?: string;
    toolCallId?: string;
    memoryId?: string;
    jobId?: string;
  };

  // If downgraded
  downgradedFrom?: ActionType;
  downgradedReason?: string;

  // If failed
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };

  // Audit
  auditLevel: 'summary' | 'redacted_full' | 'full';
  auditEntry?: string;  // JSON or redacted summary
}
```

---

## 5. Memory Records

### 5.1 Memory Record

```typescript
interface MemoryRecord {
  id: string;  // stable opaque ID; some worker effects use a versioned hash

  // Ownership
  scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
  canonicalUserId?: string;  // if scope=user
  groupId?: string;  // if scope=group
  conversationId?: string;  // if scope=conversation
  subjectUserId?: string;  // who the memory is about (if different from owner)

  // Boundaries
  visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'owner_admin_only' | 'public';
  sensitivity: 'normal' | 'personal' | 'sensitive' | 'secret' | 'prohibited';
  authority: 'user_stated' | 'inferred' | 'tool_derived' | 'system';

  // Content
  kind: 'preference' | 'fact' | 'constraint' | 'summary' | 'reflection' | 'procedure';
  title: string;
  content: string;

  // Lifecycle
  state: 'proposed' | 'active' | 'rejected' | 'superseded' | 'disabled' | 'deleted';
  // Repository lifecycle updates cannot transition an existing record back to
  // proposed; proposal state is created only by governed memory creation.
  // Repository approve/reject operations require current state=proposed.
  // Other repository state changes must follow the lifecycle state machine:
  // active -> disabled/deleted/superseded, disabled/rejected/deleted -> active
  // restore or deletion where applicable, superseded -> deleted.
  confidence: number;  // 0.0 - 1.0
  importance: number;  // 0.0 - 1.0

  // Provenance
  sourceContext: string;  // where it came from
  sourceEventIds: string[];
  evaluatorDecisionId?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}
```

### 5.2 Memory Source Link

```typescript
interface MemorySourceInput {
  sourceType: 'raw_event' | 'chat_message' | 'tool_output' | 'worker_extraction' | 'user_command';
  sourceId: string;
  sourceTimestamp?: Date | number;
  extractedBy?: 'user' | 'evaluator' | 'tool' | 'worker';
  external?: boolean;
}

interface MemorySourceRow {
  memoryId: string;
  sourceType: MemorySourceInput['sourceType'];
  sourceId: string;
  sourceTimestamp: Date;
  extractedBy?: MemorySourceInput['extractedBy'];
  resolutionState: 'internal' | 'external' | 'legacy_unresolved';
  rawEventId?: string;
  chatMessageId?: string;
  toolCallId?: string;
  jobId?: string;
  jobAttemptId?: string;
}
```

Repository-backed creation requires a non-empty `sources[]`; `sourceContext`
describes policy context and never supplies source identity. New internal
sources resolve inside the create transaction: `raw_event` to `raw_events.id`,
`chat_message` to `chat_messages.id`, `tool_output` to a successful
`tool_calls.id`, and `worker_extraction` to exactly one completed extraction
job or completed attempt. A worker link also requires a separate raw/chat source
on the same request that is referenced by the job payload/result evidence.

Only `user_command` may be opaque. It requires `external=true`, an `admin_cli`
actor context, and an `admin_cli` source context; internal types reject the
external flag. New writes never create `legacy_unresolved` rows. Compatibility
migration may retain that state for historical provenance that cannot be
resolved safely.

Source IDs must be non-empty and unique within one create request, source
timestamps must be finite, and optional lifecycle `expiresAt` must be finite.
Omitted, malformed, orphaned, wrong-table, or semantically unusable evidence
rejects the transaction before any memory, source, revision, audit, or FTS row
survives. No `memory:<memoryId>` fallback is created.

Repository retrieval/search applies lifecycle, sensitivity, and context
visibility predicates before applying result limits. Private-only or otherwise
inaccessible records cannot consume the limited candidate window for group
contexts.
Context assembly must pass the current conversation context into prompt-eligible
memory retrieval and use separate scoped lookups for same-group or
same-conversation memory so context-local IDs do not accidentally become broad
metadata filters for all user/global memories.
It may derive bounded FTS queries only from the explicit current message, an
exactly resolved same-conversation quote, and the recent same-conversation
thread. Each FTS call retains the route's SQL boundary predicates before its
limit. The query text, tokens, MATCH syntax, message IDs, and BM25 values are
ephemeral. ContextTrace persists only the fixed `MemorySelectionEvidence`
categories above, ordered exactly like `selectedMemoryIds`; rejection reasons
continue to account for every other bounded candidate.

The current record's `evaluatorDecisionId` describes the latest governed
mutation, not immutable creation authority. A lifecycle write uses its explicit
evaluator decision when supplied; otherwise it writes
`policy:l0:<target-state>:<memory-id>` to the record, new revision, and audit.
It never inherits the previous mutation's ID. Creation authority remains in
revision 1's decision column and snapshot plus the `memory.create` audit. Durable
extraction retry validates those immutable create fields and ignores legitimate
later lifecycle identity, confidence, importance, and state changes.


### 5.3 Memory Revision

```typescript
interface MemoryRevision {
  id: string;
  memoryId: string;
  revisionNumber: number;

  previousState: Partial<MemoryRecord>;
  newState: Partial<MemoryRecord>;

  reason: string;
  changeType: 'create' | 'update' | 'approve' | 'reject' | 'supersede' | 'disable' | 'delete' | 'restore';

  actor: string;  // canonical_user_id or 'system'
  evaluatorDecisionId?: string;

  createdAt: Date;
}
```

---

## 6. Tool Registry

### 6.1 Tool Registry Entry

```typescript
interface ToolRegistryEntry {
  name: string;  // unique tool identifier
  version: string;
  description: string;

  // Capabilities (what it can do)
  capabilities: ToolCapability[];

  // Permissions (who can use it)
  permissions: ToolPermissionPolicy;

  // Evaluator policy (LLM review required?)
  evaluatorPolicy: 'required' | 'bypass';

  // Audit (what to log)
  auditLevel: 'none' | 'summary' | 'redacted_full' | 'full';

  // Sandbox (execution constraints)
  sandboxPolicy: SandboxPolicy;

  // Output handling
  outputSensitivity: 'normal' | 'personal' | 'sensitive' | 'secret_possible';

  // Pi integration
  piSchema: {
    input: object;  // JSON schema
    output: object;  // JSON schema
  };

  // Resolved handler function
  handler: ToolHandler;
}

type ToolCapability =
  | 'read_context'
  | 'read_local'
  | 'write_local'
  | 'network'
  | 'shell_exec'
  | 'long_running'
  | 'sends_message'
  | 'modifies_memory'
  | 'external_side_effect'
  | 'credential_access'
  | 'platform_admin';

interface ToolPermissionPolicy {
  allowedActors: ActorClass[];
  allowedContexts: InvocationContext[];
  allowedUserIds?: string[];
  deniedUserIds?: string[];
  allowedGroupIds?: string[];
  deniedGroupIds?: string[];
}

type ActorClass =
  | 'owner'
  | 'admin'
  | 'trusted_user'
  | 'user'
  | 'group_admin'
  | 'system_worker'
  | 'evaluator'
  | 'tool';

type InvocationContext =
  | 'private_chat'
  | 'group_chat'
  | 'admin_cli'
  | 'background_worker'
  | 'internal';

interface SandboxPolicy {
  filesystem: 'none' | 'readonly' | 'workspace_write' | 'allowed_paths';
  network: 'none' | 'restricted' | 'allowed';
  execution: 'none' | 'in_process' | 'subprocess' | 'docker';
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  allowedPaths?: string[];
  allowedDomains?: string[];
}

interface ToolHandlerRequest {
  toolCallId: string;
  turnId: string;
  toolName: string;
  signal: AbortSignal;
  evaluatorDecisionId?: string;
  sourceEventIds?: string[];
  input: unknown;
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    groupId?: string;
  };
  context: InvocationContext;
}

type ToolHandler = (request: ToolHandlerRequest) => Promise<unknown>;
```

Optional `maxRuntimeMs` and `maxOutputBytes` metadata must be positive safe
integers, and `maxRuntimeMs` may not exceed the host timer maximum
`2147483647`. Immediately before handler invocation, after policy and evaluator
checks, the Pi wrappers compose the optional Pi signal and registered runtime
limit into the required handler signal. A pre-aborted call never invokes the
handler. Upstream cancellation records `error / TOOL_EXECUTION_ABORTED`; runtime
expiry records `timeout / TOOL_RUNTIME_LIMIT_EXCEEDED`. Both use fixed messages,
await actual handler settlement, and prevent a late result or prepared local
effect from becoming success.

The output limit must be at least the computed stable truncation envelope size
(currently `87` UTF-8 bytes). After secret/platform redaction, PiAdapter
independently bounds prompt text and JSON-serialized durable output. Truncated
output carries `[TRUNCATED:tool_output]`; oversized structured output is replaced
with `{ truncated: true, originalBytes, preview }`. A handler that resolves
inside its runtime boundary remains `success` / `tool.executed`, including a
prepared local effect that commits once with the bounded terminal pair.
Cancellation is cooperative: a non-cooperative in-process handler is still
awaited, and already-performed external effects cannot be rolled back.

### 6.2 Tool Call

```typescript
interface ToolCallRequest {
  id: string;  // ULID
  turnId: string;
  toolName: string;

  input: object;  // validated against tool's piSchema.input

  requestedBy: 'pi' | 'evaluator' | 'user' | 'system';
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    groupId?: string;  // runtime policy context for group-scoped permissions
  };

  context: InvocationContext;
}

interface ToolCallResult {
  toolCallId: string;
  status: 'success' | 'error' | 'timeout' | 'rejected';

  output?: object;  // validated against tool's piSchema.output
  error?: {
    code: string;
    message: string;
    details?: object;
  };

  executionTimeMs: number;

  // Audit
  auditSummary: string;  // redacted if sensitive
  secretsRedacted: boolean;
}
```

---

## 7. Agent Turn

### 7.1 Agent Turn

```typescript
interface AgentTurn {
  id: string;  // ULID, also serves as turnId
  conversationId: string;

  // Input
  triggerEvent: { id: string; type: string };
  contextPackId: string;

  // Pi interaction
  piPromptId?: string;
  piModel: string;
  piProvider: string;

  // Output
  actionDecisionId?: string;
  responseText?: string;  // pre-action-guard Pi draft
  toolCalls: string[];  // ToolCallRequest IDs

  // Lifecycle
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: Date;
  completedAt?: Date;

  // Token usage
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}
```

For completed reply turns, `responseText` preserves the Pi draft before the
memory-claim guard. The executable action decision, delivered message, and
persisted `bot.response` evidence use the guarded action payload instead.

The production `PiAdapter.runTurn()` invocation has a cooperative deadline from
`PI_TURN_TIMEOUT_MS` (default `120000`, valid range `1..2147483647`). Deadline
expiry calls Pi abort once, awaits prompt/idle settlement, and returns a stable
failed result before the application terminalizes the durable turn. This does
not promise forced termination when a provider or in-process tool ignores the
abort signal, and it does not currently change the unused streaming-turn
lifecycle.

Because `PiAdapter` owns one mutable SDK Agent, every `runTurn()` and
`streamTurn()` invocation acquires the same FIFO lease before resetting or
installing turn state. The adapter resets the retained SDK transcript under that
lease and releases it only after the prompt and idle state settle and the result
is captured or generator cleanup completes. Queued `runTurn()` deadlines begin
after lease acquisition. Closing a streamed turn early aborts an active Agent run
and awaits prompt plus idle settlement before releasing the next turn; the
streaming surface still has no automatic deadline.

After a pending turn exists, caught context, action-decision, bot-response
persistence, or completion-write failures terminalize it as `failed`, set
`completedAt`, and write linked coarse `event_processing_failures` evidence when
that failure ledger remains writable. Local `bot.response` raw-event and
bot-self chat-message rows commit in one SQLite transaction: a late chat-row
failure rolls back the matching raw row while already completed external-send
and action-execution evidence remains unchanged. This does not make an external
platform send transactional with SQLite and does not guarantee terminalization
when the terminal state write itself is unavailable.

### 7.2 Structured Evaluator Invocation

The non-test social and evaluator-required tool paths use a stateless model
evaluator. Each call contains one bounded user message, no tools, and no retained
session history. Prompt projection omits durable turn/source/owner identifiers
and social delivery targets, applies secret/platform redaction per structured
value, and caps the serialized prompt at 16,384 UTF-8 bytes with a visible
truncation marker. The completion is capped at 16,384 UTF-8 bytes and must be one
strict domain-specific JSON object.
For `openai-completions`, the installed Pi client also adds
`response_format={type:"json_object"}` through the provider payload hook without
copying tools or transcript state. Other API families keep their native payload
unchanged.

The model cannot supply durable authority metadata. LetheBot generates the
decision ID and decided-at timestamp locally, copies the request ID from the
original request, and derives evaluator version from configured
provider/model/prompt version. A first-call JSON parse or strict schema failure
terminalizes call 1 and permits exactly one fresh correction call. The correction
prompt does not include the invalid response, and parsing remains strict; a
second invalid result is terminal. Timeout, provider, empty, oversized,
persistence, and other runtime failures do not enter the correction path and
fail closed with bounded diagnostics. `LETHEBOT_TEST=true` or explicit evaluator identity
`mock` / `mock` selects the rule-driven stub; non-mock credential/configuration
failures never fall back to it.

Automatic background memory extraction uses the same configured evaluator and
persists its structured decision under the exact current extraction job
attempt. The decision and governed memory or rejection-audit effect commit in
one immediate transaction. Both before and after the synchronous effect, the
attempt must be running, current by attempt number, owned by the matching
worker/lease owner, and unexpired; lost authority rolls back the whole effect.

Every non-mock model evaluation first creates call 1 as a running
`purpose='evaluator'` `model_invocations` row with the exact turn or job-attempt
owner, request/domain, configured provider/model/prompt version, and ordered raw
event sources. Call 2 is allowed only after matching call 1 durably fails with
`invalid_structured_output`; it must keep that exact owner, identity, and ordered
source set. No call 3 is valid. Valid structured output terminalizes its row as
`completed` with token counts plus only a response hash/byte count; timeout,
abort, Provider, empty, oversized, and invalid-structured-output failures
terminalize it without creating a decision. A successful result carries the
locally assigned invocation ID for the call that succeeded. The tool, social, or memory decision writer revalidates the complete binding
and stores it in the nullable unique
`evaluator_decisions.model_invocation_id` foreign key inside the existing business
transaction. Stub/local/legacy decisions keep that field null. A completed but
unlinked invocation proves that a local Provider call completed before downstream
persistence failed; it does not count as reviewed-action evidence. Neither prompt
nor response content is stored in this ledger.

After terminal model-evaluator failure, domain services retain fail-closed
business evidence without manufacturing a decision: social persists an
evaluator-required, explicitly failed all-`silent_store` action decision; memory
persists one idempotent bounded rejection audit and no memory; a required tool
persists rejected `tool_calls` and `tool.rejected` audit rows with
`EVALUATOR_ERROR` and never invokes its handler.

---

## 8. Audit & Errors

### 8.1 Audit Entry

```typescript
interface AuditEntry {
  id: string;  // ULID
  timestamp: Date;

  category: 'tool' | 'memory' | 'social' | 'evaluator' | 'system';
  level: 'summary' | 'redacted_full' | 'full';

  // What happened
  eventType: string;
  eventId: string;  // references the actual event

  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    context: InvocationContext;
  };

  // Summary (always present)
  summary: string;

  // Details (redacted if level != full)
  details?: object;
  redacted: boolean;

  // Risk flags
  riskLevel?: 'low' | 'medium' | 'high' | 'prohibited';
  evaluatorDecisionId?: string;
}
```

### 8.2 Error Envelope

```typescript
interface ErrorEnvelope {
  code: string;  // e.g., 'MEMORY_NOT_FOUND', 'PERMISSION_DENIED'
  message: string;
  category: 'validation' | 'permission' | 'not_found' | 'conflict' | 'rate_limit' | 'internal';

  details?: object;
  recoverable: boolean;

  // For debugging (never exposed to untrusted context)
  stack?: string;
  internalError?: Error;
}
```

---

## 9. Attention Signals (Fast Classification)

The Attention Engine does NOT build full ActionDecision. It only does fast classification and extracts basic signals.

```typescript
interface AttentionSignals {
  classification: 'silent' | 'defer' | 'needs_response' | 'needs_evaluation';

  // Basic trigger signals
  triggerScore: number;  // 0.0 - 1.0
  triggerReasons: string[];  // e.g., ['@bot', 'reply_to_bot']

  // Basic suppressors
  suppressors: string[];  // e.g., ['high_speed_chat', 'bot_spoke_recently']

  // Recommended path
  recommendedPath:
    | 'silent_fast_path'
    | 'delayed_recheck'
    | 'reply_fast_path'
    | 'risk_path';
}
```

**Design rationale:** This keeps `silent_fast_path` truly fast. Pi supplies the
candidate response, the evaluator may review risky plans, and
`SocialDecisionService` constructs and persists the `ActionDecision` only when
a turn reaches the social-decision stage.

For an otherwise unaddressed QQ group question, the current engine emits
`classification='defer'` and `recommendedPath='delayed_recheck'`. The ingress
handler creates no turn, calls neither Pi nor the evaluator, and performs no
gateway send. It commits the derived `chat_messages` row, one source-bound
`attention_candidates` row, and one scheduled `attention_recheck` job in the
same immediate SQLite transaction. Candidate/job creation is idempotent by the
canonical raw-event source, and the job payload must be exactly
`{ candidateId: string }`.

Delayed policy time is anchored to local ingress, not the OneBot/platform event
clock. `attention_candidates.observed_at` equals `raw_events.created_at`, and
eligibility also requires the matching accepted receipt `received_at` and
admission `accepted_at` to equal that value. `not_before_at` is exactly 15,000 ms
after `observed_at`; `expires_at` is exactly 120,000 ms after it.

At or after `not_before_at`, the durable handler reconstructs the strict stored
`ChatMessageReceived` from the canonical raw/chat rows and revalidates that it
still matches the deferred policy. Under an immediate transaction, a new
decision requires the exact candidate/job binding and current unexpired
job-attempt lease. There is at most one decision per candidate. Suppression is
selected in this order:

1. `thread_expired` when `now >= expires_at`;
2. `human_answer` for a later non-bot gateway message explicitly replying to
   the source message in the same conversation and group;
3. `high_traffic` when at least six non-bot QQ gateway messages fall in the
   exact group's rolling 10-second window; or
4. `group_budget_exhausted` when that group already has two `respond` decisions
   in the rolling 10-minute window.

When none applies, inserting `outcome='respond'` reserves the group budget in
that same transaction. Re-entry changes the stored deferred signals to
`needs_response` / `reply_fast_path`, adds `delayed_recheck` to
`triggerReasons`, and runs the ordinary turn pipeline with
`sourceAlreadyPersisted`; it does not reinsert the raw event or chat message.
The unmentioned group response is still locally marked proactive, so its action
and evaluator request retain `proactive=true` and evaluator review is required.

The completed job result is content-free and bounded. Suppression returns the
candidate/decision IDs, `outcome`, and suppressor ID/code pairs. Response returns
the candidate/decision/turn IDs, optional action decision/execution IDs, and a
`deliveryRecorded` boolean. On retry, the service reuses the single decision;
the response handler reuses a locally delivered or completed terminal turn and
rejects pending/running or action-started evidence whose delivery state is
indeterminate. This prevents a second send when durable evidence exists, but it
does not claim external exactly-once if the process fails after QQ accepts a send
and before local execution/delivery evidence is committed.

Retention excludes candidate source raw/chat rows while the linked job is
`pending` or `running`. After the job becomes terminal, source retention may
delete those rows; the schema cascades deletion through the candidate,
decision, and suppressors while preserving the independent `jobs` and
`job_attempts` history.

`triggerScore` is bounded relevance telemetry, not a risk score. Combining
`@bot`, verified reply-to-bot, private-message, and question signals never
selects `risk_path` by itself. QQ governance commands are intercepted before
Attention and therefore are not Attention relevance or risk signals.

### 9.1 QQ Governance Commands

The complete case-sensitive grammar is `/memory`, `/memory forget <memory-id>`,
`/memory summary status|enable|disable`, and `/why`. Parsing is deterministic:
surrounding/inter-token whitespace is allowed, recognized input is bounded to
512 characters, and a memory ID matches
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Malformed `/memory` or `/why` families
remain recognized; an authorized actor receives deterministic usage output,
while an unauthorized actor receives the same denial as for valid syntax.
Prefix collisions such as `/memoryx` or `/whyever`, generic `!` commands, and
natural-language management text remain ordinary input.

After identity/display handling, a recognized family commits its derived chat
row and creates a local `provider=local`, `model=qq-governance-v1` turn before
the normal Attention call. `GovernanceService` then rereads exactly one matching
canonical QQ gateway raw row, derived chat row, normalized stored payload, and
active account/canonical-user mapping. Any mismatch fails source verification;
the service reparses the persisted chat text and derives authority again rather
than trusting the application event or parser result.

QQ authority is the optional configured `LETHEBOT_BOT_OWNER_QQ_ID` matching the
normalized sender account exactly, or a stored `owner`/`admin` role in the exact
current group. Every recognized unauthorized command returns the same bounded
denial. A group `/memory` listing is limited to non-secret, non-deleted exact
group/conversation records and same-group user records; it excludes private,
global, and other-group records even for the bot owner. A broad private-chat
listing is available only to that configured bot owner. Group owner/admin
`forget` is restricted to the same group-safe record set. A bot owner or
`local_admin` CLI may forget a known ID broadly; unavailable, deleted, and
unauthorized IDs are indistinguishable. Forget uses the memory repository's
normal deleted-state revision/audit transaction, so retrieval exclusion is
immediate.

Summary commands require a group source and apply to exactly its persisted
group. Missing policy means disabled. A changed enable/disable state advances
the generation and records actor/source audit evidence; requesting the current
state is an idempotent no-op. Disable prevents enqueue/retrieval and atomically
marks bound pending summary jobs failed/canceled without deleting retained
summary memory. Re-enable establishes a later eligibility boundary and does not
backfill the disabled interval. `/why` reports only bounded/redacted counts and
status for the latest prior QQ turn in the exact conversation, ordered by
canonical raw-event ingress; the command turn and every other conversation are
excluded.

The service result becomes one low-risk, `decidedBy='attention'`,
`evaluatorRequired=false`, `proactive=false` reply action and is executed through
`ActionExecutor`; group uses `reply_short` and private uses `reply_full`. No
recognized command calls Pi, an evaluator, or a tool. A successful execution
stores exactly the delivered reply as `bot.response` and completes the local
turn with zero tokens. Canonical ingress deduplication prevents a duplicate
turn, governance effect, or send. A handled `SEND_MESSAGE_FAILED` result leaves
the local turn completed, preserves the durable failed action execution, and
creates no `bot.response` or event-processing failure. Thrown governance,
repository, post-send response-persistence, or turn-finalization errors use the
ordinary failed-turn/admission path, including the `governance_command` failure
stage when applicable.

CLI `delete-memory` and
`memory-summary <status|enable|disable> --group <groupId>` call the same service
with actor `local_admin` and invocation context `admin_cli`. CLI output is
bounded/redacted; QQ and CLI policy mutations share the same lifecycle,
cancellation, and audit implementation.

---

## 10. Design Decisions Record

### Decision: Attention Output (Q1)

**Chosen:** Option A - Attention Engine only does fast classification.

**Rationale:** Keeps silent_fast_path truly fast. Most group messages should not build ActionDecision at all.

### Decision: Memory Proposal (Q2)

**Chosen:** Option A - Use `state` field in MemoryRecord.

**Rationale:** Simpler for P0. Single table, single type. Separate MemoryProposal type adds complexity without clear P0 benefit.

### Decision: Gateway Capabilities Timing (Q3)

**Chosen:** Option A - Report capabilities with every message.

**Rationale:** Safety over efficiency. Capabilities can change at runtime (e.g., NapCat updates). Per-message overhead is acceptable for correct behavior.

### Decision: Identity in Context Pack (Q4)

**Chosen:** Current granularity is appropriate.

**Rationale:** ParticipantContext includes exactly what's needed for policy
decisions (role, trust flags) and prompt rendering (displayName), plus optional
platformAccountId when debugging/disambiguation is needed. Group packs derive
participants only from selected human message actors and bind them to opaque
pack-local `speaker_N` references. Display labels are metadata, never identity;
duplicate labels remain distinct speakers and missing display metadata renders
as `unknown`.

---

## 11. Implementation Guidance

For current implementation evidence, sequencing, tests, and acceptance criteria, see:

- **`docs/long-running-goal-state.md`** - active requirement/evidence checkpoint
- **`docs/one-shot-full-completion-constraints.md`** - long-horizon execution and proof rules
- **`docs/test-strategy.md`** - deterministic regression tests and acceptance criteria
- **`docs/fake-gateway-design.md`** - test harness interface and test scenarios
- **`docs/sqlite-schema.md`** - complete database schema with indexes

`docs/next-full-implementation-plan.md` and historical phase-by-phase task lists
are planning context only and must not be treated as current completion evidence.
