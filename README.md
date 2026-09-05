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
pnpm install --frozen-lockfile

# 2. Run the deterministic CI-equivalent gate
pnpm ci:check

# 3. Create a local runtime environment file when needed
cp .env.example .env

# 4. Start the configured development runtime
pnpm dev:env
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

The latest recorded deterministic audit has the local product at
`DETERMINISTIC_READY`; production/live acceptance remains incomplete. A historic
live runtime sample predates the deterministic speaker/quote, evaluator,
delayed Attention, governance, restart-memory, retrieval, and tool-catalog
fixes, so it is retained as context rather than current completion evidence.

`LOCAL_COMPLETE_EXTERNAL_BLOCKED` describes the recorded P0-P9 operational
baseline, not completion of the original product vision. The full delivery
contract also requires procedural memory, semantic retrieval, and
reflection/importance scoring (V1-V3). Their current implementation and evidence
status belong in the checkpoint. Fresh Provider/QQ acceptance, controlled
restart/restore/rollback, and the real runtime soak remain required final gates:

- [Long-Term Development Program And Constraints](docs/long-term-development-constraints.md)
- [Long-Term Development Goal Prompt](docs/prompts/repair-and-long-term-development-goal.md)
- [Long-Term Development Delivery Contract](docs/long-term-development-delivery.md)
- [Current Goal State](docs/long-running-goal-state.md)
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
- [Current Goal State](docs/long-running-goal-state.md) - Current evidence, phase, and exact next slice
- [Long-Term Development Constraints](docs/long-term-development-constraints.md) - P0-P9 and V1-V3 program and completion contract
- [Long-Term Development Delivery Contract](docs/long-term-development-delivery.md) - Capability acceptance, release evidence, and handoff
- [Reliability Constraints](docs/group-chat-reliability-constraints.md) - Scoped conversation invariants reused by the program
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

Inspect and change the restart-scoped reviewed tool catalog (the mutation
commands require the env file used by the launcher):

```bash
pnpm cli list-tools --env-file .env
pnpm cli tool-status memory.search --env-file .env
pnpm cli disable-tool memory.search --env-file .env
pnpm cli enable-tool memory.search --env-file .env
```

## Current Stack

- Runtime: Node.js 22.19+ / TypeScript
- Agent core: Pi SDK behind LetheBot's adapter boundary
- Gateway: NapCat / OneBot v11 WebSocket with optional reverse HTTP
- Storage: SQLite WAL with `better-sqlite3` repositories
- Search: SQLite FTS
- Background jobs: SQLite-backed durable workers
- Governance UI: bundled browser assets served by the local governance server

See [Tech Stack](docs/tech-stack.md) for details.

## License

MIT. See [LICENSE](LICENSE).
