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

## Quick Start

### Development Mode (No Real API Keys Required)

Development mode uses MockPi and FakeOneBot for testing without real API keys or NapCat.

```bash
# 1. Install dependencies
pnpm install

# 2. Create environment file
cp .env.example .env

# 3. Run tests
pnpm test:run

# 4. Type check
pnpm typecheck

# 5. Lint
pnpm lint
```

### Production Deployment

See [Deployment Guide](docs/deployment.md) for detailed instructions on:

- Switching from MockPi to real Pi API
- Connecting to real NapCat / OneBot gateway
- Database setup and migrations
- Security configuration
- Monitoring and backup

## Project Structure

```
LetheBot/
├── src/
│   ├── types/          # TypeScript interfaces (contracts)
│   ├── storage/        # SQLite repositories
│   ├── gateway/        # OneBot adapter interface
│   ├── attention/      # Attention engine (trigger scoring)
│   ├── context/        # Context builder (memory visibility)
│   ├── pi/             # Pi SDK adapter (MockPi for testing)
│   ├── tools/          # Tool registry
│   ├── policy/         # Policy gate and evaluator
│   ├── workers/        # Background workers
│   └── cli/            # Governance CLI
├── tests/
│   ├── unit/           # Unit tests
│   ├── fakes/          # Test harness (FakeOneBot)
│   └── phase-acceptance/  # Phase gate tests
├── migrations/         # SQLite schema migrations
└── docs/               # Architecture and design docs
```

## Current Status

MVP implementation completed (Phases A-L). Test coverage: 247 tests passing.

**Implemented:**
- ✅ Core TypeScript contracts
- ✅ SQLite storage with migrations
- ✅ Memory visibility filtering
- ✅ Attention engine with trigger scoring
- ✅ Mock Pi adapter (testing without real API key)
- ✅ Context builder with memory retrieval
- ✅ Tool registry with permission checks
- ✅ Policy gate with L0 enforcement
- ✅ Background worker queue
- ✅ Governance CLI (list/delete/disable memory)

**Pending:**
- ⏳ Real Pi SDK adapter (see [deployment.md](docs/deployment.md))
- ⏳ Real OneBot adapter for NapCat (see [deployment.md](docs/deployment.md))
- ⏳ Smoke test script
- ⏳ Health check endpoint

## Documentation

Start here:

- [Agent Instructions](AGENTS.md) - Contribution rules
- [Documentation Index](docs/README.md) - All design docs
- [Architecture](docs/architecture.md) - System design
- [MVP Roadmap](docs/mvp-roadmap.md) - Development phases
- [Deployment Guide](docs/deployment.md) - Production setup

Key concepts:

- [Contracts](docs/contracts.md) - TypeScript interfaces
- [Memory System](docs/memory-system.md) - Memory lifecycle and visibility
- [Security & Privacy](docs/security-privacy.md) - Governance and audit
- [Tool Registry](docs/tool-registry.md) - Tool permissions
- [Agent Governance](docs/agent-governance.md) - Evaluator and policy

## Governance CLI

Manage memory and audit logs:

```bash
# List all active memory
pnpm cli list-memory

# List memory for specific user
pnpm cli list-memory --user user-alice

# Filter by state
pnpm cli list-memory --state proposed

# Disable memory
pnpm cli disable-memory <memory-id>

# Delete memory
pnpm cli delete-memory <memory-id>

# Restore disabled memory
pnpm cli enable-memory <memory-id>
```

## Recommended Initial Stack

- Runtime: TypeScript / Node.js
- Agent core: Pi SDK first, Pi RPC as fallback
- Gateway: NapCat / OneBot adapter
- Storage: SQLite WAL as source of truth
- Search: SQLite FTS plus vector sidecar or sqlite-vec
- Background jobs: SQLite-backed queue first, Redis/BullMQ later if needed
- Governance UI: lightweight web UI after the first CLI tools exist

See [Tech Stack](docs/tech-stack.md) for details.

## License

(To be determined)

