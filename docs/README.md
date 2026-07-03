# LetheBot Documentation

This directory is the implementation-facing documentation set for LetheBot.

Current docs are split into three classes:

1. **Canonical architecture and constraints** — must be read before changing related code.
2. **Next implementation plan** — the current full-function development roadmap.
3. **Archive** — historical prompts, loop states, completion reports, discussion logs, and retired plans. Archive files are useful context only; they are not completion evidence.

## Canonical Reading Order

1. [Vision](vision.md)
2. [Architecture](architecture.md)
3. [Design Decisions](design-decisions.md)
4. [Long-Term Development Constraints](long-term-development-constraints.md)
5. [Next Full Implementation Plan](next-full-implementation-plan.md)
6. [Contracts](contracts.md)
7. [Data Model](data-model.md)
8. [SQLite Schema](sqlite-schema.md)
9. [Memory System](memory-system.md)
10. [Identity Model](identity-model.md)
11. [Context Orchestration](context-orchestration.md)
12. [Social Action Model](social-action-model.md)
13. [Agent Governance](agent-governance.md)
14. [Tool Registry](tool-registry.md)
15. [Pi Integration](pi-integration.md)
16. [Security and Privacy](security-privacy.md)
17. [Tech Stack](tech-stack.md)
18. [Deployment](deployment.md)
19. [Local Container Acceptance](local-container-acceptance.md)
20. [Operations](operations.md)
21. [Troubleshooting](troubleshooting.md)
22. [Test Strategy](test-strategy.md)

## Focus Documents

- [Long-Term Development Constraints](long-term-development-constraints.md) — hard evidence, architecture, memory, privacy, testing, and Git constraints.
- [Next Full Implementation Plan](next-full-implementation-plan.md) — the current roadmap for completing all LetheBot functions, not only MVP behavior.
- [Next Full Implementation `/goal` Prompt](prompts/next-full-implementation-goal.md) — copy-paste prompt for the next development loop.

## Supporting References

- [Escalation Checklist](escalation-checklist.md) — product/security decisions that should be escalated instead of guessed.
- [Fake Gateway Design](fake-gateway-design.md) — test harness notes for protocol/runtime parity.
- [Examples](examples/) — concrete memory visibility, OneBot flow, and tool registration examples.

## Archive Policy

`docs/archive/` contains historical material:

- completion reports and READY/MVP claims;
- previous loop-state checkpoints;
- old phase plans and prompts;
- discussion logs and review notes;
- generated architecture artifacts.

Rules:

- Do not use archive docs as proof that a feature currently works.
- If archive content conflicts with current code, tests, or canonical docs, current evidence wins.
- New work should update canonical docs and the current implementation plan, not resurrect old loop-state files.

## Design Center

LetheBot should be easy to experiment with, but hard to make opaque. The system can learn aggressively in the background, but durable memory must remain inspectable, editable, and deletable.
