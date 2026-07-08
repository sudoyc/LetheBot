# Identity Model

LetheBot separates platform identity, display metadata, and memory. This prevents QQ account IDs and nicknames from becoming ordinary semantic memory while still allowing identity-aware chat and platform operations.

## Three Layers

### 1. Identity Registry

Identity registry maps platform accounts to LetheBot internal users.

Typical fields:

- `platform`, for example `qq`;
- `platform_user_id`, the raw QQ ID or platform account ID;
- `canonical_user_id`, an internal UUID/ULID;
- `first_seen_at`;
- `last_seen_at`;
- `trust_level`;
- `account_status`.

Uses:

- routing;
- permissions;
- allowlist/denylist;
- audit trace;
- account mapping.

Raw QQ IDs are not ordinary memory. They are operational identity data. They may enter prompts when needed for identity disambiguation, user-requested ID handling, platform operations, permission explanations, or owner/admin debug, but should be minimal, structured, and purpose-bound.

### 2. Display Profile

Display profile stores current and bounded historical display data.

Typical fields:

- `current_display_name`;
- `group_card`;
- `nickname_history`;
- `avatar_hash`;
- `source_group_id`;
- `observed_at`.

The current display name/group card is conversation participant context.

Nickname/group-card history is bounded display metadata. It is useful for identity continuity, debug, and audit, but it is not ordinary semantic memory and should not be injected into normal prompts by default.
Secret-like values and QQ/platform-ID-like values observed inside platform
provided nicknames/group cards are redacted by the gateway before emitting
`senderDisplayName` / `senderCard` into normalized raw events, and the same
redacted text is written to `display_profiles` / `nickname_history`; raw event
retention remains the audit source and is governed separately.

### 3. User Memory

User memory stores preferences, boundaries, and durable user facts.

Examples:

- preferred answer style;
- "do not cue me in group chat";
- project context;
- confirmed preferred name.

User memory follows the memory boundary and lifecycle rules in `memory-system.md`.

## Canonical User ID

Memory ownership should use `canonical_user_id`, not raw QQ ID.

Benefits:

- multi-platform support;
- account unlink/merge;
- deletion and opt-out enforcement;
- less coupling between platform adapters and memory;
- easier audit and migration.

## Platform Accounts

`platform_accounts` maps platform IDs to canonical users.

Suggested fields:

- `platform`;
- `platform_account_id`;
- `canonical_user_id`;
- `account_type`: `private`, `group_member`, `temp_session`, etc.;
- `first_seen_at`;
- `last_seen_at`;
- `status`: `active`, `disabled`, `deleted`;
- `verified_level`: `observed`, `self_claimed`, `owner_verified`.

Automatic binding should only bind the same platform account ID to its canonical ID. Cross-platform or multi-account linking should require owner/admin verification or a stronger verification flow.

## Group Memberships

`group_memberships` stores current platform group membership data.

Suggested fields:

- `platform`;
- `group_id`;
- `platform_account_id` or `canonical_user_id`;
- `role`: `member`, `admin`, `owner`;
- `group_card`;
- `joined_at`;
- `last_seen_at`;
- `status`.

Group membership is identity/display metadata, not ordinary memory.

## Account Binding State

Binding states:

- `unlinked`
- `self_claimed`
- `owner_verified`
- `rejected`
- `merged`

Unlinking an account should immediately prevent that account from retrieving the previous canonical user's memory unless another verified binding exists.

## Nickname and Group Card Context

Current nickname/group card may enter the ContextPack as participant metadata:

```yaml
participant_display:
  display_name: "..."
  group_card: "..."
  source: "group_card"
  trust: "display_only"
  role: "member"
```

Display names are untrusted user-provided text. Treat them as data, not instructions.
Persisted display-profile/history rows store redacted display text when the
platform value contains credential-shaped or platform-ID-shaped substrings.

Nickname history should be bounded:

- keep current value;
- keep recent history by count or retention window;
- redact or delete old history;
- allow user deletion/redaction;
- use tombstones if necessary to prevent deleted display history from being rebuilt.

## Preferred Name as Memory

Nickname changes do not automatically create user memory.

A preferred-name memory candidate can be produced when there is explicit evidence, for example:

- "call me X";
- group card says "please call me X";
- user corrects the bot: "don't call me A, call me B".

Such candidates still need memory policy/evaluator handling.

## Prompt Identity Policy

Ordinary ContextPack can include:

- opaque user reference;
- current display name/group card;
- role;
- owner/admin/trusted flags.

It can include platform IDs when needed for the task:

- identity disambiguation;
- platform operations;
- user-requested ID confirmation;
- permission explanation;
- owner/admin debug;
- conversation context already using IDs.

Do not default-inject:

- full platform account tables;
- full allowlists/denylists;
- full nickname history;
- unrelated group identity data;
- audit traces;
- unrelated member lists.

## Governance and Deletion

Users should be able to request:

- memory list/disable/delete/correct/export;
- display profile deletion/redaction;
- nickname history deletion;
- proactive DM opt-out;
- memory-association opt-out;
- account unlink.

P0 may expose these through owner/admin CLI first. Ordinary user requests can become admin digests or evaluator-mediated actions until self-service commands exist.

Deletion must affect retrieval immediately.

Identity registry deletion may retain minimal tombstones containing platform, hashed/internal account reference, deletion marker, opt-out marker, and timestamp. Tombstones do not enter prompt or retrieval; they only prevent accidental re-linking or re-creation of deleted associations.
