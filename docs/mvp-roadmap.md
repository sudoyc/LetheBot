# MVP Roadmap

The MVP should prove one thing: LetheBot can join QQ, remember useful facts, inject them into Pi, and let the user inspect or delete them.

## Phase 0: Repository and Design

- Document architecture.
- Define project rules.
- Choose initial stack.
- Create GitHub repository.

## Phase 1: QQ Gateway

- Connect to NapCat / OneBot.
- Receive private and group messages.
- Send text replies.
- Normalize messages into internal events.
- Persist raw events.

## Phase 2: Pi Runtime

- Embed Pi SDK in a TypeScript service.
- Run one agent turn from a private message.
- Stream and persist agent events.
- Register a minimal tool set.

## Phase 3: Memory v0

- Store user profile records.
- Store group profile records.
- Add manual memory create/search/delete.
- Add source metadata and lifecycle states.

## Phase 4: Context Builder v0

- Inject user profile.
- Inject group profile.
- Inject recent messages.
- Inject rolling group summary.
- Record selected memory IDs per turn.

## Phase 5: Background Summaries

- Summarize group windows.
- Extract memory proposals.
- Promote only high-confidence or manually accepted records.

## Phase 6: Governance

- CLI or simple web page for memory inspection.
- Delete and disable memory.
- Show why a response used a memory.

## MVP Exit Criteria

- One QQ group and private chat can run for several days.
- User-specific memory affects answers.
- Group memory affects answers.
- Memory can be inspected and deleted.
- Context injection decisions are logged.

