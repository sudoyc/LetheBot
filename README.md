# LetheBot

LetheBot is a local-first, thick-memory chatbot project built around a strong but lightweight reasoning core. The early target is QQ private chat and group chat through NapCat / OneBot, with a memory system that can remember users, groups, long-running context, and reusable procedures over time.

The project name references Lethe, the mythic river of forgetting. The design goal is intentionally paradoxical: the bot remembers deeply, but every memory must be inspectable, governable, and forgettable by design.

## Goals

- Use Pi or a Pi-like agent runtime as the reasoning core.
- Keep memory outside the core as a thick, modular, auditable framework.
- Support per-user profiles, group memory, episodic memory, semantic facts, skills, and layered prompts.
- Make QQ group chat context injection intelligent instead of dumping raw chat history.
- Stay local-first and privacy-oriented.
- Keep the system playful and easy to extend with new tools, experiments, and sandboxes.

## Current Status

This repository is in the design and scaffolding phase. The current deliverables are architecture documents and project working rules.

Start here:

- [Agent Instructions](AGENTS.md)
- [Documentation Index](docs/README.md)
- [Architecture](docs/architecture.md)
- [MVP Roadmap](docs/mvp-roadmap.md)

## Recommended Initial Stack

- Runtime: TypeScript / Node.js
- Agent core: Pi SDK first, Pi RPC as fallback
- Gateway: NapCat / OneBot adapter
- Storage: SQLite WAL as source of truth
- Search: SQLite FTS plus vector sidecar or sqlite-vec
- Background jobs: SQLite-backed queue first, Redis/BullMQ later if needed
- Governance UI: lightweight web UI after the first CLI tools exist

See [Tech Stack](docs/tech-stack.md) for details.

