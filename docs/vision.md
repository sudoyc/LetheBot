# Vision

LetheBot is a persistent chatbot that remembers people, groups, conversations, and useful procedures over time.

The core idea is to combine:

- A strong, lightweight reasoning core based on Pi.
- A thick memory layer outside the core.
- Explicit context orchestration.
- Local-first persistence and user-governed memory.
- A modular backend that makes tool experiments easy.

## Product Goals

- Remember individual users across private chats and group chats.
- Remember group culture, rules, topics, and long-running context.
- Inject only relevant context into the reasoning core.
- Let users inspect, edit, disable, or delete memory.
- Support long-running background learning and consolidation.
- Start with QQ through NapCat / OneBot, then expand to more platforms.

## Non-Goals for MVP

- Perfect autonomous memory extraction.
- Full knowledge graph UI.
- Multi-platform support.
- Multi-agent orchestration.
- Heavy distributed infrastructure.

## Design Principles

- Raw events are not memory by themselves.
- Long-term memory must have source, confidence, and lifecycle state.
- Context injection must be explainable.
- Platform adapters should stay thin.
- Pi should be integrated as a core runtime, not treated as an opaque CLI when SDK integration is possible.

