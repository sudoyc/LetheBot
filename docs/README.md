# LetheBot Documentation

This directory is the implementation-facing documentation set for LetheBot.

Current docs are split into four classes:

1. **Canonical architecture and constraints** — must be read before changing related code.
2. **Active operational state** — the mutable long-running checkpoint and its
   execution constraints; this is current coordination state, not completion proof.
3. **Planning references** — useful hypotheses and sequencing ideas that must be
   revalidated against current code/tests before use.
4. **Archive** — historical prompts, loop states, completion reports, discussion logs, and retired plans. Archive files are useful context only; they are not completion evidence.

## Canonical Reading Order

1. [Vision](vision.md)
2. [Architecture](architecture.md)
3. [Design Decisions](design-decisions.md)
4. [Long-Term Development Constraints](long-term-development-constraints.md)
5. [Contracts](contracts.md)
6. [Data Model](data-model.md)
7. [SQLite Schema](sqlite-schema.md)
8. [Memory System](memory-system.md)
9. [Identity Model](identity-model.md)
10. [Context Orchestration](context-orchestration.md)
11. [Social Action Model](social-action-model.md)
12. [Agent Governance](agent-governance.md)
13. [Tool Registry](tool-registry.md)
14. [Pi Integration](pi-integration.md)
15. [Security and Privacy](security-privacy.md)
16. [Tech Stack](tech-stack.md)
17. [Deployment](deployment.md)
18. [Local Container Acceptance](local-container-acceptance.md)
19. [Operations](operations.md)
20. [Troubleshooting](troubleshooting.md)
21. [Test Strategy](test-strategy.md)

## Focus Documents

- [Long-Term Development Constraints](long-term-development-constraints.md) — hard evidence, architecture, memory, privacy, testing, and Git constraints.
- [Long-Running Goal State](long-running-goal-state.md) — mutable current
  requirement/evidence checkpoint and ordered repair route; this is the only
  mutable status document and is never completion proof by itself.
- [Group Chat Reliability Constraints](group-chat-reliability-constraints.md) —
  scoped speaker, quote, Attention, evaluator, memory-truthfulness, sequencing,
  and verification invariants for the active repair.
- [Group Chat Reliability `/goal` Prompt](prompts/group-chat-reliability-goal.md)
  — active scoped execution prompt for the current reliability repair.
- [Long-Horizon Full Completion Constraints](one-shot-full-completion-constraints.md) — resumable supervisor-loop, checkpoint, critical-path, stop, and completion rules for a goal spanning many verified slices.
- [Long-Horizon Full Completion `/goal` Prompt](prompts/one-shot-full-completion-goal.md) — umbrella production-readiness prompt; use it only when that broader objective is explicitly selected.
- [Next Full Implementation Plan](next-full-implementation-plan.md) — superseded
  2026-07-03 planning snapshot; use only as a hypothesis after checking current
  implementation, tests, and the active requirement matrix.

Do not maintain a second current roadmap, gap-analysis log, or loop-state file.
Stable decisions belong in `design-decisions.md`; current evidence and the exact
next slice belong only in `long-running-goal-state.md`.

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
- New work should update canonical docs and the active checkpoint, not resurrect
  old loop-state files or treat a superseded plan as current evidence.

## Design Center

LetheBot should be easy to experiment with, but hard to make opaque. The system can learn aggressively in the background, but durable memory must remain inspectable, editable, and deletable.
