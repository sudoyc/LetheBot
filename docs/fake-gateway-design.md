# Fake Gateway Test Harness

This document defines the test double for OneBot/NapCat gateway, used in Phase D and all subsequent phases for testing without a real QQ connection.

## Design Goals

1. **Enable Phase D-G testing without real NapCat**
2. **Simulate all message types** (private, group, @bot, reply-to-bot, reactions)
3. **Verify bot's outgoing messages** (assertions on sent content)
4. **Control capabilities** (enable/disable reactions, folded forward)
5. **Simulate timing and concurrency** (message order, rapid-fire)

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
  simulatePrivateMessage(options: SimulatePrivateMessageOptions): SimulatedMessage;
  simulateGroupMessage(options: SimulateGroupMessageOptions): SimulatedMessage;
  simulateReaction(messageId: string, emoji: string): void;
  simulateGroupMemberUpdate(options: SimulateGroupMemberUpdateOptions): void;
  
  // Control capabilities
  setCapabilities(capabilities: Partial<GatewayCapabilities>): void;
  
  // Inspect bot's output
  getSentMessages(): SentMessage[];
  getLastSentMessage(): SentMessage | undefined;
  getSentReactions(): SentReaction[];
  
  // Assertions
  assertMessageSent(matcher: MessageMatcher): void;
  assertNoMessageSent(): void;
  assertReactionSent(messageId: string, emoji: string): void;
  
  // Reset state
  reset(): void;
}
```

---

## Configuration

```typescript
interface FakeOneBotConfig {
  // Default bot ID
  botId: string;  // default: 'fake-bot-123'
  
  // Default capabilities
  capabilities?: Partial<GatewayCapabilities>;
  
  // Behavior
  autoIncrement?: {
    messageIds?: boolean;  // auto-generate message IDs
    userIds?: boolean;  // auto-generate user IDs
  };
  
  // Timing simulation
  deliveryDelayMs?: number;  // simulate network delay
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
const msg = fakeGateway.simulatePrivateMessage({
  senderId: 'user-alice',
  text: '你好',
});
// Returns SimulatedMessage with generated messageId
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
const msg = fakeGateway.simulateGroupMessage({
  groupId: 'group-tech',
  senderId: 'user-bob',
  text: '@bot 帮我查一下',
  mentionsBot: true,
  senderRole: 'member',
});
```

### Return Type

```typescript
interface SimulatedMessage {
  messageId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  senderId: string;
  timestamp: Date;
  
  // Useful for chaining
  waitForReply(timeoutMs?: number): Promise<SentMessage>;
}
```

---

## Inspect Bot Output

### Get Sent Messages

```typescript
interface SentMessage {
  messageId: string;  // generated when sent
  conversationId: string;
  conversationType: 'private' | 'group';
  
  content: {
    text?: string;
    media?: MediaAttachment[];
  };
  
  sentAt: Date;
  
  // If folded forward
  foldedForward?: boolean;
}

// Usage
const sent = fakeGateway.getSentMessages();
expect(sent).toHaveLength(1);
expect(sent[0].content.text).toContain('你好');
```

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

### Scenario 1: Silent Fast Path

```typescript
test('silent_fast_path: ordinary group message without @bot', () => {
  const gateway = new FakeOneBot();
  const bot = new LetheBot({ gateway });
  
  gateway.simulateGroupMessage({
    groupId: 'casual-chat',
    senderId: 'user-alice',
    text: '今天天气不错',
    mentionsBot: false,
  });
  
  // Wait for processing
  await bot.processEvents();
  
  // Assert no message sent
  gateway.assertNoMessageSent();
  
  // Assert raw event was stored
  const events = await bot.storage.getRawEvents({ limit: 1 });
  expect(events[0].type).toBe('chat.message.received');
});
```

### Scenario 2: Reply Fast Path

```typescript
test('reply_fast_path: @bot in group triggers reply', async () => {
  const gateway = new FakeOneBot();
  const bot = new LetheBot({ gateway });
  
  const msg = gateway.simulateGroupMessage({
    groupId: 'tech-support',
    senderId: 'user-bob',
    text: '@bot 你好',
    mentionsBot: true,
  });
  
  await bot.processEvents();
  
  // Assert reply sent
  gateway.assertMessageSent(/你好|hi/i);
  
  const sent = gateway.getLastSentMessage();
  expect(sent.conversationId).toBe('group:tech-support');
});
```

### Scenario 3: Capability Fallback

```typescript
test('react_only falls back when emojiLike unsupported', async () => {
  const gateway = new FakeOneBot();
  gateway.setCapabilities({
    reactions: { emojiLike: false, faceMessage: true },
  });
  
  const bot = new LetheBot({ gateway });
  
  gateway.simulateGroupMessage({
    text: '@bot 点个赞',
    mentionsBot: true,
  });
  
  await bot.processEvents();
  
  // Should fall back to face message
  const sent = gateway.getLastSentMessage();
  expect(sent.content.text).toMatch(/[\u{1F44D}\[赞\]]/u);  // face or emoji in text
});
```

### Scenario 4: Memory Visibility

```typescript
test('private_only memory not leaked to group', async () => {
  const gateway = new FakeOneBot();
  const bot = new LetheBot({ gateway });
  
  // User tells bot a secret in private chat
  gateway.simulatePrivateMessage({
    senderId: 'user-alice',
    text: '/remember 我的密码是 secret123',
  });
  await bot.processEvents();
  
  // User asks in group
  gateway.simulateGroupMessage({
    groupId: 'public-group',
    senderId: 'user-alice',
    text: '@bot 我的密码是什么',
    mentionsBot: true,
  });
  await bot.processEvents();
  
  // Assert bot does not leak the password
  const sent = gateway.getLastSentMessage();
  expect(sent.content.text).not.toContain('secret123');
  expect(sent.content.text).toMatch(/私聊|隐私|不能在群里/);
});
```

### Scenario 5: Concurrent Messages

```typescript
test('handles rapid-fire group messages gracefully', async () => {
  const gateway = new FakeOneBot();
  const bot = new LetheBot({ gateway });
  
  // Simulate 10 rapid messages
  for (let i = 0; i < 10; i++) {
    gateway.simulateGroupMessage({
      senderId: `user-${i}`,
      text: `消息 ${i}`,
      mentionsBot: false,
    });
  }
  
  await bot.processEvents();
  
  // Assert most messages triggered silent_fast_path
  const sent = gateway.getSentMessages();
  expect(sent.length).toBeLessThan(3);  // bot should not spam
  
  // Assert all events stored
  const events = await bot.storage.getRawEvents({ limit: 20 });
  expect(events.length).toBeGreaterThanOrEqual(10);
});
```

---

## Implementation Notes

### P0 Scope

For Phase D, implement:
- ✅ `simulatePrivateMessage`
- ✅ `simulateGroupMessage`
- ✅ `getSentMessages` / `getLastSentMessage`
- ✅ `assertMessageSent` / `assertNoMessageSent`
- ✅ `setCapabilities`
- ✅ `reset`

### P1 (Later Phases)

- `simulateReaction`
- `simulateGroupMemberUpdate`
- `getSentReactions`
- `SimulatedMessage.waitForReply`
- Timing simulation (deliveryDelayMs)

### Integration with Real Gateway

FakeOneBot should implement the same `GatewayAdapter` interface as the real `OneBotAdapter`, so they can be swapped:

```typescript
interface GatewayAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Real gateway uses these to send
  sendMessage(target: MessageTarget, content: MessageContent): Promise<string>;
  sendReaction(messageId: string, emoji: string): Promise<void>;
  
  // Event emitter for incoming messages
  on(event: 'message', handler: (msg: ChatMessageReceived) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}
```

---

## File Location

Suggested structure:

```
tests/
├── fakes/
│   ├── fake-onebot.ts          # FakeOneBot class
│   ├── fake-onebot.test.ts     # Self-tests for FakeOneBot
│   └── index.ts
└── integration/
    ├── silent-fast-path.test.ts
    ├── reply-fast-path.test.ts
    ├── memory-visibility.test.ts
    └── ...
```

---

## Open Question

**Q: Should FakeOneBot auto-trigger bot's event processing, or require explicit `bot.processEvents()`?**

**Decision: Option B - Manual trigger (explicit for tests)**

```typescript
gateway.simulateGroupMessage({ text: '@bot hi' });
await bot.processEvents();  // Explicit control
```

**Rationale:** 
- Tests have full control over timing
- Async behavior is explicit and easier to understand  
- Can set up additional state before triggering
- Option A (auto-trigger) can be added later as a convenience mode

---

## Real NapCat for Integration Testing

For Phase E (real OneBot adapter) and Phase M (live soak test), a real NapCat instance is available on `arqelvps` in a Docker container.

This can be used for:
- Integration smoke tests with real QQ protocol
- Verifying OneBot v11 WebSocket behavior
- Testing real reactions, folded forward, and platform admin features
- Multi-day soak testing

P0 tests should still use FakeOneBot for speed and isolation. Real NapCat is for final integration verification only.
