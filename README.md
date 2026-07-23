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

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues:
- OneBot connection problems
- Pi API configuration (DeepSeek, OpenAI)
- Database and migration issues
- Test failures and debugging

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

## Documentation

- [Architecture](docs/architecture.md) - System design and module overview
- [Deployment Guide](docs/deployment.md) - Production setup with DeepSeek/NapCat
- [Troubleshooting](docs/troubleshooting.md) - Common issues and solutions

### Examples
- [Tool Registration](docs/examples/tool-registration-example.md)
- [Memory Visibility](docs/examples/memory-visibility-scenarios.md)
- [OneBot Message Flow](docs/examples/onebot-message-flow.md)

## Current Status

The only mutable evidence/status checkpoint is
[docs/long-running-goal-state.md](docs/long-running-goal-state.md). Do not use
old loop-state files, gap analyses, prompt files, or historical test counts as
current completion evidence.

The latest controlled audit found the OneBot transport, SQLite persistence,
outbound delivery, and extraction worker operational. It also found that the
bot is not yet reliably usable for multi-person quoted group conversation:
historical speakers collapse in prompt context, quote relations do not reach
Pi, ordinary relevance is conflated with evaluator risk, and group continuity
has no active/selected memory or summaries.

The active repair is defined by:

- [Group Chat Reliability Constraints](docs/group-chat-reliability-constraints.md)
- [Group Chat Reliability Goal Prompt](docs/prompts/group-chat-reliability-goal.md)
- [Test Strategy Behavior Matrix](docs/test-strategy.md#conversation-reliability-matrix)
- [Local Container Behavior Canary](docs/local-container-acceptance.md#验收步骤)

Healthy containers or a delivered message are not production-readiness claims.
The checkpoint records the exact evidence, ordered repair route, and remaining
acceptance gates.

## Documentation

Start here:

- [Agent Instructions](AGENTS.md) - Contribution rules
- [Documentation Index](docs/README.md) - All design docs
- [Architecture](docs/architecture.md) - System design
- [Current Goal State](docs/long-running-goal-state.md) - Current evidence and ordered repair route
- [Reliability Constraints](docs/group-chat-reliability-constraints.md) - Active scoped invariants
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
