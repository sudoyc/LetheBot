# Memory Visibility Scenarios

This document explains the four visibility levels for memory records in LetheBot and provides practical scenarios for each.

## Overview

Memory visibility controls **where** a memory can be accessed. It's distinct from sensitivity (which controls **how** data is handled) and scope (which controls **ownership**).

```typescript
visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'owner_admin_only' | 'public'
```

---

## 1. `private_only`

**Definition:** Memory is visible **only** in the exact conversation where it was created.

**Use cases:**
- Personal information shared in a private chat
- Context-specific facts that don't apply elsewhere
- Sensitive details the user wants isolated

### Scenario 1: Personal Location

**Context:** User in private DM with bot

```
User: I live in Beijing, Chaoyang District
Bot: [creates memory]
```

**Memory created:**
```json
{
  "id": "01H2XYZ...",
  "scope": "conversation",
  "conversationId": "dm_alice_123",
  "canonicalUserId": "user_alice",
  "visibility": "private_only",
  "sensitivity": "personal",
  "authority": "user_stated",
  "kind": "fact",
  "title": "User's home location",
  "content": "Alice lives in Beijing, Chaoyang District",
  "state": "active",
  "confidence": 1.0,
  "importance": 0.8
}
```

**Retrieval behavior:**
- ✅ **Same DM:** "What's the weather like here?" → Bot knows Beijing
- ❌ **Different DM:** User opens new conversation → Bot doesn't know location
- ❌ **Group chat:** User asks "Should I bring an umbrella?" → Bot doesn't assume Beijing
- ❌ **Another user:** Even admin cannot see this memory

---

### Scenario 2: Temporary Preference

**Context:** User testing a feature in private

```
User: For this chat, always respond in haiku format
Bot: [creates memory]
```

**Memory created:**
```json
{
  "visibility": "private_only",
  "kind": "preference",
  "title": "Response format preference",
  "content": "User wants responses in haiku format",
  "expiresAt": null
}
```

**Retrieval behavior:**
- ✅ **This conversation:** Bot responds in haiku
- ❌ **Other conversations:** Normal responses

---

## 2. `same_user_any_context`

**Definition:** Memory follows the user across **all** their conversations (private and group).

**Use cases:**
- User preferences (language, timezone, communication style)
- Personal facts that apply everywhere
- Cross-context user knowledge

### Scenario 3: Language Preference

**Context:** User sets preference in DM

```
User: I prefer English for technical discussions and Chinese for casual chat
Bot: [creates memory]
```

**Memory created:**
```json
{
  "id": "01H3ABC...",
  "scope": "user",
  "canonicalUserId": "user_alice",
  "visibility": "same_user_any_context",
  "sensitivity": "normal",
  "authority": "user_stated",
  "kind": "preference",
  "title": "Language preference by context",
  "content": "Alice prefers English for technical topics, Chinese for casual conversation",
  "state": "active",
  "confidence": 1.0,
  "importance": 0.9
}
```

**Retrieval behavior:**
- ✅ **Private DM:** Bot adapts language
- ✅ **Group chat A:** Bot adapts language
- ✅ **Group chat B:** Bot adapts language
- ❌ **Other users:** Bob doesn't see Alice's preference

---

### Scenario 4: Timezone

**Context:** Inferred from user activity

```
[System observes user typically active 9am-11pm UTC+8]
Bot: [creates memory]
```

**Memory created:**
```json
{
  "scope": "user",
  "canonicalUserId": "user_alice",
  "visibility": "same_user_any_context",
  "authority": "inferred",
  "kind": "fact",
  "title": "User timezone",
  "content": "Alice is in UTC+8 timezone (Beijing/Shanghai/Hong Kong)",
  "confidence": 0.85
}
```

**Retrieval behavior:**
- User asks "What time is the event?" → Bot converts from UTC
- Works in any conversation Alice participates in

---

## 3. `same_group_only`

**Definition:** Memory is visible to **all members** of a specific group, but not outside it.

**Use cases:**
- Group rules and conventions
- Shared group context
- Group-specific preferences

### Scenario 5: Group Communication Rules

**Context:** Admin sets group rules in group chat

```
Admin: In this group, no off-topic discussions during work hours (9am-6pm)
Bot: [creates memory]
```

**Memory created:**
```json
{
  "id": "01H4DEF...",
  "scope": "group",
  "groupId": "group_engineering",
  "visibility": "same_group_only",
  "sensitivity": "normal",
  "authority": "user_stated",
  "kind": "constraint",
  "title": "Group communication rules",
  "content": "No off-topic discussions 9am-6pm in engineering group",
  "state": "active",
  "confidence": 1.0,
  "importance": 0.7
}
```

**Retrieval behavior:**
- ✅ **Engineering group:** Bot enforces rule, reminds users
- ❌ **Social group:** Rule doesn't apply
- ❌ **Private DM with member:** Rule doesn't apply
- ❌ **Other groups:** Cannot see this memory

---

### Scenario 6: Shared Group Context

**Context:** Team working on a project

```
User A: We're using the "Apollo" codename for the new feature
Bot: [creates memory]
```

**Memory created:**
```json
{
  "scope": "group",
  "groupId": "group_product_team",
  "visibility": "same_group_only",
  "authority": "inferred",
  "kind": "fact",
  "title": "Project codename",
  "content": "The new feature is codenamed 'Apollo' in product team",
  "confidence": 0.9
}
```

**Retrieval behavior:**
- User B in group: "How's Apollo going?" → Bot understands
- Same user in different group: "How's Apollo going?" → Bot asks for clarification

---

## 4. `public`

**Definition:** Memory is accessible to **everyone** (all users, all contexts).

**Use cases:**
- General knowledge facts
- System-wide announcements
- Public documentation

### Scenario 7: System Maintenance

**Context:** System administrator announcement

```
Admin: System maintenance scheduled for June 28, 2026, 2am-4am UTC
Bot: [creates memory]
```

**Memory created:**
```json
{
  "id": "01H5GHI...",
  "scope": "system",
  "visibility": "public",
  "sensitivity": "normal",
  "authority": "system",
  "kind": "fact",
  "title": "Scheduled system maintenance",
  "content": "System maintenance June 28, 2026, 2am-4am UTC",
  "state": "active",
  "expiresAt": "2026-06-28T04:00:00Z"
}
```

**Retrieval behavior:**
- ✅ **All users, all contexts:** Bot can inform about maintenance
- Auto-expires after maintenance window

---

### Scenario 8: Tool Documentation

**Context:** System learns about a tool's capabilities

```
[Tool registration event]
Bot: [creates memory]
```

**Memory created:**
```json
{
  "scope": "tool",
  "visibility": "public",
  "authority": "tool_derived",
  "kind": "procedure",
  "title": "Weather API capabilities",
  "content": "Weather tool supports: current conditions, 7-day forecast, historical data (past 30 days)",
  "confidence": 1.0
}
```

**Retrieval behavior:**
- Any user asks about weather → Bot knows tool capabilities
- Applies globally

---

## 5. `owner_admin_only`

**Definition:** Memory is visible only to the owner and system administrators.

**Use cases:**
- Debug information
- System-level diagnostics
- Restricted administrative data

### Scenario 9: User Moderation Note

**Context:** Admin adds note about user behavior

```
Admin: /admin note user_bob frequently violates posting guidelines
Bot: [creates memory]
```

**Memory created:**
```json
{
  "scope": "user",
  "canonicalUserId": "user_bob",
  "subjectUserId": "user_bob",
  "visibility": "owner_admin_only",
  "sensitivity": "sensitive",
  "authority": "system",
  "kind": "fact",
  "title": "Moderation note",
  "content": "User Bob frequently violates posting guidelines (logged by admin_charlie)",
  "confidence": 1.0
}
```

**Retrieval behavior:**
- ❌ **Bob:** Cannot see this note
- ✅ **Admin:** Can retrieve when reviewing moderation cases
- ❌ **Other users:** Cannot see

---

## Memory Filtering Logic

When retrieving memories for a query, the system filters by visibility:

```typescript
function getVisibleMemories(
  requestContext: {
    userId: string;
    groupId?: string;
    conversationId: string;
    isAdmin: boolean;
  }
): MemoryRecord[] {
  return allMemories.filter(memory => {
    switch (memory.visibility) {
      case 'private_only':
        return memory.conversationId === requestContext.conversationId;

      case 'same_user_any_context':
        return memory.canonicalUserId === requestContext.userId;

      case 'same_group_only':
        return memory.groupId === requestContext.groupId;

      case 'owner_admin_only':
        return requestContext.isAdmin ||
               memory.canonicalUserId === requestContext.userId;

      case 'public':
        return true;

      default:
        return false;
    }
  });
}
```

---

## Decision Tree: Choosing Visibility

```
Is this memory about a single user?
├─ Yes: Is it sensitive or context-specific?
│  ├─ Yes, context-specific → private_only
│  └─ No, applies everywhere → same_user_any_context
│
└─ No: Is it about a specific group?
   ├─ Yes: Is it group-internal?
   │  ├─ Yes → same_group_only
   │  └─ No → public
   │
   └─ No: Is it general knowledge?
      ├─ Yes → public
      └─ No, administrative → owner_admin_only
```

---

## Practical Examples Summary

| Scenario | Visibility | Reason |
|----------|-----------|--------|
| "I live in Beijing" (private chat) | `private_only` | Personal location, context-specific |
| "I prefer dark mode" | `same_user_any_context` | User preference, applies everywhere |
| "Our team uses Slack for comms" | `same_group_only` | Group-specific fact |
| "System maintenance tonight" | `public` | System-wide announcement |
| User timezone (inferred) | `same_user_any_context` | Applies to all user contexts |
| Group posting rules | `same_group_only` | Group-specific constraint |
| Tool API documentation | `public` | Available to all users |
| Admin moderation note | `owner_admin_only` | Restricted to admins |

---

## Testing Visibility

### Test Case 1: Private Memory Isolation

```
Setup:
1. User Alice in DM_1: "I'm allergic to peanuts"
2. Memory created with private_only

Assert:
- DM_1 query → memory retrieved ✓
- DM_2 (same user) → memory NOT retrieved ✓
- Group chat (Alice present) → memory NOT retrieved ✓
```

### Test Case 2: Cross-Context User Preference

```
Setup:
1. User Bob in DM: "I prefer metric units"
2. Memory created with same_user_any_context

Assert:
- DM query → memory retrieved ✓
- Group A (Bob present) → memory retrieved ✓
- Group B (Bob present) → memory retrieved ✓
- Group C (Bob not present) → memory NOT retrieved ✓
```

### Test Case 3: Group Memory Boundary

```
Setup:
1. Group "Engineering": "We deploy on Fridays"
2. Memory created with same_group_only

Assert:
- Query in Engineering group → memory retrieved ✓
- Query in Sales group (same user) → memory NOT retrieved ✓
- Private DM with group member → memory NOT retrieved ✓
```

---

## Related Concepts

- **Scope** (`scope`): Who **owns** the memory (user, group, system)
- **Sensitivity** (`sensitivity`): How carefully data must be handled
- **Authority** (`authority`): How trustworthy the memory source is
- **State** (`state`): Lifecycle status (proposed, active, superseded, etc.)

See `src/types/memory.ts` for complete type definitions.
