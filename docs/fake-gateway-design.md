# Fake Gateway Test Harness

This document defines the deterministic OneBot/NapCat gateway test double used
without a real QQ connection.

## Design Goals

1. **Enable credential-free gateway and conversation testing**
2. **Simulate private/group messages, @bot, and reply-to-bot inputs**
3. **Verify outgoing messages and reactions** (assertions on recorded effects)
4. **Control capabilities** (enable/disable reactions, folded forward)
5. **Exercise deterministic ordering and rapid-fire event delivery**

---

## Core Interface

### FakeOneBot Class

```typescript
class FakeOneBot implements GatewayAdapter {
  // Setup
  constructor(config?: FakeOneBotConfig);
  
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Simulate incoming messages
  simulatePrivateMessage(options: SimulatePrivateMessageOptions): void;
  simulateGroupMessage(options: SimulateGroupMessageOptions): void;
  
  // Control capabilities
  setCapabilities(capabilities: Partial<GatewayCapabilities>): void;
  
  // Inspect bot's output
  getSentMessages(): SentMessage[];
  getLastSentMessage(): SentMessage | undefined;
  getSentReactions(): SentReaction[];
  getLastSentReaction(): SentReaction | undefined;
  
  // Assertions
  assertMessageSent(matcher?: MessageMatcher): void;
  assertNoMessageSent(): void;
  assertReactionSent(messageId: string, emoji?: string): void;
  
  // Reset state
  reset(): void;
}
```

---

## Configuration

```typescript
interface FakeOneBotConfig {
  // Default bot ID
  botId?: string;  // default: 'fake-bot-123'
  
  // Default capabilities
  capabilities?: Partial<GatewayCapabilities>;
}
```

---

## Simulate Incoming Messages

### Private Message

```typescript
interface SimulatePrivateMessageOptions {
  senderId?: string;  // default: 'fake-user-001'
  text: string;
  messageId?: string;  // auto-generated if not provided
  timestamp?: Date;  // default: now
  
  // Optional features
  quote?: {
    messageId: string;
    text: string;
  };
  media?: MediaAttachment[];
}

// Usage
fakeGateway.simulatePrivateMessage({
  senderId: 'user-alice',
  text: '你好',
});
```

### Group Message

```typescript
interface SimulateGroupMessageOptions {
  groupId?: string;  // default: 'fake-group-001'
  senderId?: string;  // default: 'fake-user-001'
  text: string;
  messageId?: string;
  timestamp?: Date;
  
  // Group-specific
  senderRole?: 'member' | 'admin' | 'owner';
  senderCard?: string;  // group card / nickname
  
  // Bot mention
  mentionsBot?: boolean;  // auto-detects @bot in text if not specified
  replyToMessageId?: string;
  
  // Optional features
  quote?: { messageId: string; text: string };
  media?: MediaAttachment[];
}

// Usage
fakeGateway.simulateGroupMessage({
  groupId: 'group-tech',
  senderId: 'user-bob',
  text: '@bot 帮我查一下',
  mentionsBot: true,
  senderRole: 'member',
});
```

The simulation methods emit the normalized event synchronously and return
`void`. Supply `messageId` explicitly when a test needs to reference the inbound
message later.

---

## Inspect Bot Output

### Get Sent Messages

```typescript
interface SentMessage {
  messageId: string;  // generated when sent
  conversationId: string;
  conversationType: 'private' | 'group';
  
  content: MessageContent;
  
  sentAt: Date;
}

// Usage
const sent = fakeGateway.getSentMessages();
expect(sent).toHaveLength(1);
expect(sent[0].content.text).toContain('你好');
```

### Get Sent Reactions

```typescript
interface SentReaction {
  messageId: string;  // target/source message ID reacted to
  emoji: string;
  sentAt: Date;
}

const reactions = fakeGateway.getSentReactions();
expect(reactions[0]).toMatchObject({ messageId: 'msg-123', emoji: '👍' });
expect(fakeGateway.getLastSentReaction()?.emoji).toBe('👍');
```

`sendReaction()` records reaction side effects separately from sent messages, so
tests can distinguish true reaction delivery from face/text fallback messages.
`reset()` clears both sent messages and sent reactions.

### Assertions

```typescript
type MessageMatcher = 
  | string  // contains text
  | RegExp  // matches pattern
  | { text?: string | RegExp; conversationId?: string };

// Assert message sent
fakeGateway.assertMessageSent('操作成功');
fakeGateway.assertMessageSent(/成功|完成/);
fakeGateway.assertMessageSent({ 
  text: '私聊回复', 
  conversationId: 'private:user-alice' 
});

// Assert no message sent (for silent_fast_path tests)
fakeGateway.assertNoMessageSent();

// Assert reaction sent
fakeGateway.assertReactionSent('msg-123', '👍');
fakeGateway.assertReactionSent('msg-123');
```

---

## Control Capabilities

```typescript
// Enable full capabilities
fakeGateway.setCapabilities({
  reactions: { emojiLike: true, faceMessage: true },
  foldedForward: { groupForward: true, privateForward: true, customNode: true },
  platformAdmin: { kick: true, mute: true, setGroupCard: true },
});

// Disable reactions (test fallback behavior)
fakeGateway.setCapabilities({
  reactions: { emojiLike: false, faceMessage: false },
});
```

---

## Test Scenarios

### Scenario 1: Normalized Group Event

```typescript
test('emits one normalized group event synchronously', () => {
  const gateway = new FakeOneBot();
  const events: ChatMessageReceived[] = [];
  gateway.on('message', (event) => events.push(event));

  gateway.simulateGroupMessage({
    groupId: 'casual-chat',
    senderId: 'user-alice',
    text: '今天天气不错',
    mentionsBot: false,
  });

  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('chat.message.received');
  expect(events[0].message.conversationId).toBe('group:casual-chat');
});
```

### Scenario 2: Exact Bot Mention

```typescript
test('recognizes the configured bot in a CQ mention', () => {
  const gateway = new FakeOneBot({ botId: '3889000770' });
  let received: ChatMessageReceived | undefined;
  gateway.on('message', (event) => { received = event; });

  gateway.simulateGroupMessage({
    text: '[CQ:at,qq=3889000770] 你好',
  });

  expect(received?.message.mentionsBot).toBe(true);
  expect(received?.message.mentions).toEqual(['qq-3889000770']);
});
```

### Scenario 3: Outbound Reaction Recording

```typescript
test('records a reaction separately from messages', async () => {
  const gateway = new FakeOneBot();

  await gateway.sendReaction('msg-123', '👍');

  gateway.assertReactionSent('msg-123');
  expect(gateway.getLastSentReaction()?.emoji).toBe('👍');
  gateway.reset();
  expect(gateway.getSentReactions()).toHaveLength(0);
});
```

### Scenario 4: Quoted Reply Metadata

```typescript
test('preserves quote and reply-to metadata', () => {
  const gateway = new FakeOneBot();
  let received: ChatMessageReceived | undefined;
  gateway.on('message', (event) => { received = event; });

  gateway.simulateGroupMessage({
    groupId: 'tech-support',
    text: '继续',
    mentionsBot: false,
    replyToMessageId: 'bot-msg-1',
    quote: { messageId: 'bot-msg-1', text: '上一条回复' },
  });

  expect(received?.message.replyToMessageId).toBe('bot-msg-1');
  expect(received?.message.content.quote?.messageId).toBe('bot-msg-1');
});
```

### Scenario 5: Rapid-Fire Ordering

```typescript
test('emits rapid-fire messages in call order', () => {
  const gateway = new FakeOneBot();
  const messageIds: string[] = [];
  gateway.on('message', (event) => messageIds.push(event.message.messageId));

  for (let i = 0; i < 10; i += 1) {
    gateway.simulateGroupMessage({ text: `消息 ${i}`, mentionsBot: false });
  }

  expect(messageIds).toHaveLength(10);
  expect(messageIds).toEqual([
    'fake-msg-000001', 'fake-msg-000002', 'fake-msg-000003',
    'fake-msg-000004', 'fake-msg-000005', 'fake-msg-000006',
    'fake-msg-000007', 'fake-msg-000008', 'fake-msg-000009',
    'fake-msg-000010',
  ]);
});
```

---

## Implementation Notes

### Current Deterministic Scope

The current harness provides:
- ✅ `simulatePrivateMessage`
- ✅ `simulateGroupMessage`
- ✅ `getSentMessages` / `getLastSentMessage`
- ✅ `getSentReactions` / `getLastSentReaction`
- ✅ `assertMessageSent` / `assertNoMessageSent`
- ✅ `assertReactionSent`
- ✅ `setCapabilities`
- ✅ `reset`

### Possible Extensions

- `simulateReaction`
- `simulateGroupMemberUpdate`
- Timing simulation (deliveryDelayMs)

### Integration with Real Gateway

FakeOneBot should implement the same `GatewayAdapter` interface as the real `OneBotAdapter`, so they can be swapped:

```typescript
interface GatewayAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Real gateway uses these to send
  sendMessage(target: MessageTarget, content: MessageContent): Promise<string>;
  sendReaction?(messageId: string, emoji: string): Promise<void>;
  getCapabilities(): GatewayCapabilities;
  
  // Event emitter for incoming messages
  on(event: 'message', handler: (msg: ChatMessageReceived) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  off(event: 'message' | 'error', handler: (...args: unknown[]) => void): void;
}
```

---

## File Location

Current test locations:

```
tests/
├── fakes/
│   ├── fake-onebot.ts          # FakeOneBot class
│   ├── fake-onebot.test.ts     # Self-tests for FakeOneBot
│   └── ...
└── integration/
    ├── e2e-conversation.test.ts
    ├── memory-injection.test.ts
    └── ...
```

---

## Event Delivery Semantics

`simulatePrivateMessage` and `simulateGroupMessage` emit their normalized event
synchronously to registered listeners and return `void`. Application-level
async processing is owned by the listener/runtime under test; there is no
`bot.processEvents()` API on `FakeOneBot`. Tests that exercise the full app use
the current integration harness and await that runtime's own completion signal.

---

## Real Runtime Verification

No remote host, account session, or credential is assumed by this document.
Real SnowLuma/NapCat/QQ checks require explicit authorization and must follow
`local-container-acceptance.md` with redacted evidence. Default deterministic
tests continue to use FakeOneBot for speed, isolation, and repeatability; fake
coverage does not substitute for the required live private/group acceptance.
