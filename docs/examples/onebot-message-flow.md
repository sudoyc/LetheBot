# OneBot Message Flow Documentation

This document describes how LetheBot handles OneBot 11 protocol messages through the NapCat gateway adapter.

## Overview

The `OneBotAdapter` bridges NapCat (OneBot 11 implementation) with LetheBot's internal event system. It handles:

- **Inbound**: Converting OneBot events to LetheBot's `ChatMessageReceived` format
- **Outbound**: Converting LetheBot commands to OneBot API calls
- **ID Mapping**: Translating between platform IDs and LetheBot conversation IDs

---

## 1. Message Receive Flow (NapCat → LetheBot)

```
┌──────────┐         HTTP POST          ┌─────────────────┐
│          │  ─────────────────────────> │                 │
│  NapCat  │   (OneBot 11 event JSON)    │  OneBotAdapter  │
│          │                             │                 │
└──────────┘                             └─────────────────┘
                                                   │
                                                   │ handleHttpEvent()
                                                   │
                                                   ▼
                                         ┌─────────────────┐
                                         │ convertToInternal│
                                         │     Event()      │
                                         └─────────────────┘
                                                   │
                                                   │ Emit 'event'
                                                   │
                                                   ▼
                                         ┌─────────────────┐
                                         │   EventEmitter  │
                                         │   (LetheBot)    │
                                         └─────────────────┘
```

### Step-by-Step

1. **NapCat** receives a QQ message and formats it as OneBot 11 event
2. **NapCat** sends HTTP POST to LetheBot's webhook endpoint
3. **OneBotAdapter.handleHttpEvent()** receives the raw event body
4. **convertToInternalEvent()** transforms the OneBot format to `ChatMessageReceived`
5. Adapter emits `'event'` with the internal event object
6. LetheBot's event bus delivers the event to registered handlers

### Conversation ID Mapping

| OneBot Type | Example Input | LetheBot Conversation ID |
|-------------|---------------|--------------------------|
| Private message | `user_id: 123456` | `private:qq-123456` |
| Group message | `group_id: 789012` | `qq-group-789012` |

**Private message**: `conversationId = "private:" + "qq-" + user_id`
**Group message**: `conversationId = "qq-group-" + group_id`

---

## 2. Message Send Flow (LetheBot → NapCat)

```
┌─────────────────┐
│   LetheBot      │
│   (Bot Logic)   │
└─────────────────┘
         │
         │ sendPrivateMessage() / sendGroupMessage()
         │
         ▼
┌─────────────────┐
│  OneBotAdapter  │
│   callApi()     │
└─────────────────┘
         │
         │ HTTP POST to NapCat
         │ /send_private_msg or /send_group_msg
         │
         ▼
┌─────────────────┐
│     NapCat      │
│   (QQ Client)   │
└─────────────────┘
```

### Step-by-Step

1. **LetheBot** calls adapter's `sendPrivateMessage()` or `sendGroupMessage()`
2. Adapter strips ID prefix (`"qq-"` or `"qq-group-"`) to get numeric ID
3. **callApi()** sends HTTP POST to NapCat's API endpoint:
   - URL: `{httpUrl}/send_private_msg` or `{httpUrl}/send_group_msg`
   - Headers: `Authorization: Bearer {token}` (if configured)
   - Body: JSON with `user_id`/`group_id` and `message`
4. **NapCat** returns JSON response with `status: "ok"` or error
5. Adapter validates response and throws on failure

### ID Reverse Mapping

| LetheBot Sender ID | Extracted Numeric ID | OneBot API Parameter |
|--------------------|----------------------|----------------------|
| `qq-123456` | `123456` | `user_id: 123456` |
| `qq-group-789012` | `789012` | `group_id: 789012` |

---

## 3. OneBot Event Format Examples

### Private Message Event

```json
{
  "post_type": "message",
  "message_type": "private",
  "message_id": 445566,
  "user_id": 123456,
  "message": "Hello bot!",
  "raw_message": "Hello bot!",
  "sender": {
    "user_id": 123456,
    "nickname": "Alice"
  },
  "time": 1719475200
}
```

**Converts to LetheBot internal event:**

```typescript
{
  id: "evt-1719475200000-abc123",
  type: "chat.message.received",
  timestamp: new Date(1719475200000),
  source: "gateway",
  platform: "qq",
  conversationId: "private:qq-123456",
  message: {
    messageId: "qq-445566",
    conversationId: "private:qq-123456",
    conversationType: "private",
    senderId: "qq-123456",
    content: { text: "Hello bot!", media: [], quote: undefined },
    mentions: [],
    mentionsBot: false,
    replyToMessageId: undefined
  },
  gatewayCapabilities: { ... }
}
```

### Group Message Event

```json
{
  "post_type": "message",
  "message_type": "group",
  "message_id": 778899,
  "user_id": 123456,
  "group_id": 789012,
  "message": "[CQ:at,qq=987654] Hello everyone!",
  "raw_message": "[CQ:at,qq=987654] Hello everyone!",
  "sender": {
    "user_id": 123456,
    "nickname": "Bob",
    "card": "Group Admin Bob"
  },
  "time": 1719475260
}
```

**Converts to LetheBot internal event:**

```typescript
{
  id: "evt-1719475260000-def456",
  type: "chat.message.received",
  timestamp: new Date(1719475260000),
  source: "gateway",
  platform: "qq",
  conversationId: "qq-group-789012",
  message: {
    messageId: "qq-778899",
    conversationId: "qq-group-789012",
    conversationType: "group",
    groupId: "qq-group-789012",
    senderId: "qq-123456",
    content: { text: "[CQ:at,qq=987654] Hello everyone!", media: [], quote: undefined },
    mentions: [],
    mentionsBot: true,  // Detected via [CQ:at,qq=...]
    replyToMessageId: undefined
  },
  gatewayCapabilities: { ... }
}
```

### Non-Message Event (Ignored)

```json
{
  "post_type": "notice",
  "notice_type": "group_increase",
  "group_id": 789012,
  "user_id": 654321
}
```

**Result**: `convertToInternalEvent()` returns `null` (only `post_type: "message"` is processed).

---

## 4. CQ Code Handling Basics

OneBot 11 uses **CQ codes** for rich content (images, @mentions, etc.). Current implementation:

### Mention Detection

The adapter detects bot mentions via:

```typescript
private detectMention(text: string): boolean {
  return text.includes('[CQ:at,qq=') || text.includes('@bot');
}
```

**Examples:**
- `[CQ:at,qq=987654] 你好` → `mentionsBot: true`
- `@bot 帮帮我` → `mentionsBot: true`
- `普通消息` → `mentionsBot: false`

### Current CQ Code Support

| CQ Code | Description | LetheBot Handling |
|---------|-------------|-------------------|
| `[CQ:at,qq=123]` | @mention user | Detected for `mentionsBot` flag |
| `[CQ:image,file=...]` | Image attachment | Passed through in `text`, not parsed to `media[]` |
| `[CQ:face,id=123]` | QQ emoji | Passed through in `text` |
| `[CQ:reply,id=456]` | Reply to message | Passed through in `text`, not parsed to `replyToMessageId` |

**Note**: Current implementation does **not** parse CQ codes into structured fields (`media[]`, `quote`, `replyToMessageId`). They remain in the `text` field as raw strings.

### Sending CQ Codes

When sending messages, you can include CQ codes directly in the text:

```typescript
await adapter.sendGroupMessage('qq-group-789012', '[CQ:at,qq=123456] 你好！');
await adapter.sendPrivateMessage('qq-123456', '[CQ:image,file=https://example.com/pic.jpg]');
```

NapCat will render these according to OneBot 11 specifications.

---

## 5. Conversation ID Mapping Reference

LetheBot uses prefixed conversation IDs to distinguish message types and platforms:

### Mapping Rules

```typescript
// Private message
conversationId = `private:qq-${user_id}`
// Example: user_id=123456 → "private:qq-123456"

// Group message
conversationId = `qq-group-${group_id}`
// Example: group_id=789012 → "qq-group-789012"
```

### Reverse Mapping (for sending)

```typescript
// Extract numeric user ID from sender ID
const numericUserId = userId.replace('qq-', '');
// "qq-123456" → "123456" → parseInt → 123456

// Extract numeric group ID from conversation ID
const numericGroupId = groupId.replace('qq-group-', '');
// "qq-group-789012" → "789012" → parseInt → 789012
```

### Platform Message ID Format

```typescript
platformMessageId = `qq-${message_id}`
// Example: message_id=445566 → "qq-445566"
```

### Full Example

**Incoming private message:**
- OneBot: `user_id: 123456`, `message_id: 445566`
- LetheBot: `conversationId: "private:qq-123456"`, `messageId: "qq-445566"`, `senderId: "qq-123456"`

**Outgoing reply:**
- LetheBot calls: `sendPrivateMessage("qq-123456", "Reply text")`
- Adapter sends to NapCat: `{ user_id: 123456, message: "Reply text" }`

**Incoming group message:**
- OneBot: `group_id: 789012`, `user_id: 123456`, `message_id: 778899`
- LetheBot: `conversationId: "qq-group-789012"`, `messageId: "qq-778899"`, `senderId: "qq-123456"`, `groupId: "qq-group-789012"`

**Outgoing group reply:**
- LetheBot calls: `sendGroupMessage("qq-group-789012", "Group reply")`
- Adapter sends to NapCat: `{ group_id: 789012, message: "Group reply" }`

---

## Gateway Capabilities

Each converted event includes a `gatewayCapabilities` object describing what the QQ platform supports:

```typescript
{
  platform: 'qq',
  reactions: {
    emojiLike: false,         // QQ doesn't support generic emoji reactions
    faceMessage: true         // QQ supports face messages ([CQ:face])
  },
  foldedForward: {
    groupForward: true,       // Can forward to groups
    privateForward: true,     // Can forward to private chats
    customNode: true          // Supports custom forward nodes
  },
  platformAdmin: {
    kick: false,              // Not implemented yet
    mute: false,              // Not implemented yet
    setGroupCard: false       // Not implemented yet
  }
}
```

These capabilities tell the bot logic what features are available on this platform.

---

## Implementation Notes

### Error Handling

- **API failures**: `callApi()` throws on non-200 HTTP status or `status !== 'ok'`
- **Event parsing errors**: Caught in `handleHttpEvent()`, logged, event discarded
- **Missing fields**: Uses fallbacks (`Date.now()` for missing timestamps/message_id)

### Authentication

Optional token-based authentication:

```typescript
const adapter = new OneBotAdapter({
  httpUrl: 'http://localhost:3000',
  token: 'your-secret-token'  // Optional
});
```

If provided, all API calls include `Authorization: Bearer {token}` header.

### Timestamp Conversion

OneBot 11 uses **Unix timestamp in seconds**. LetheBot uses JavaScript `Date` objects (milliseconds):

```typescript
timestamp: new Date((msg.time ?? Date.now()) * 1000)
//                                             ^^^^^ seconds → milliseconds
```

### Event ID Generation

Internal event IDs are generated with timestamp + random suffix for uniqueness:

```typescript
id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
// Example: "evt-1719475200000-abc123"
```

---

## Related Files

- **Implementation**: `/home/ycyc/projects/LetheBot/src/gateway/onebot-adapter.ts`
- **Type Definitions**: `/home/ycyc/projects/LetheBot/src/types/events.ts`
- **Architecture Doc**: `/home/ycyc/projects/LetheBot/docs/architecture.md`
- **Data Model**: `/home/ycyc/projects/LetheBot/docs/data-model.md`
