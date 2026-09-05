# LetheBot Documentation

This directory is the implementation-facing documentation set for LetheBot.

Current docs are organized into four classes:

1. **Canonical architecture and constraints** — must be read before changing related code.
2. **Active operational state and delivery contract** — the mutable long-running
   checkpoint plus stable execution, delivery, evidence, and handoff contracts;
   current status is coordination state, not completion proof.
3. **Scoped execution guidance** — the active long-term and group-reliability
   prompts that point back to the canonical control plane.
4. **Archive** — historical prompts, loop states, completion reports, discussion logs, and retired plans. Archive files are useful context only; they are not completion evidence.

## Canonical Reading Order

1. [Vision](vision.md)
2. [Architecture](architecture.md)
3. [Design Decisions](design-decisions.md)
4. [Long-Term Development Program And Constraints](long-term-development-constraints.md)
5. [Long-Term Development Delivery Contract](long-term-development-delivery.md)
6. [Contracts](contracts.md)
7. [Data Model](data-model.md)
8. [SQLite Schema](sqlite-schema.md)
9. [Memory System](memory-system.md)
10. [Identity Model](identity-model.md)
11. [Context Orchestration](context-orchestration.md)
12. [Social Action Model](social-action-model.md)
13. [Agent Governance](agent-governance.md)
14. [Local Governance Experience](governance-ui.md)
15. [Tool Registry](tool-registry.md)
16. [Pi Integration](pi-integration.md)
17. [Security and Privacy](security-privacy.md)
18. [Tech Stack](tech-stack.md)
19. [Deployment](deployment.md)
20. [Local Container Acceptance](local-container-acceptance.md)
21. [Operations](operations.md)
22. [Troubleshooting](troubleshooting.md)
23. [Test Strategy](test-strategy.md)

## Focus Documents

- [Long-Term Development Program And Constraints](long-term-development-constraints.md)
  — active P0-P9 and V1-V3 program plus stable evidence, architecture, privacy,
  verification, rollback, checkpoint, Git, and completion constraints.
- [Long-Term Development Delivery Contract](long-term-development-delivery.md)
  — required delivery units, original-vision capability acceptance, evidence
  coverage, candidate identity, executable gates, handoff package, and final
  report shape. Final P4/P9 acceptance follows completion of V1-V3.
- [Long-Term Development `/goal` Prompt](prompts/repair-and-long-term-development-goal.md)
  — active umbrella execution prompt for the next-stage program.
- [Long-Running Goal State](long-running-goal-state.md) — mutable current
  requirement/evidence checkpoint, active phase, and exact next slice; this is
  the only mutable status document and is never completion proof by itself.
- [Group Chat Reliability Constraints](group-chat-reliability-constraints.md) —
  scoped speaker, quote, Attention, evaluator, memory-truthfulness, sequencing,
  and verification invariants reused by relevant P4/P5 slices.
- [Group Chat Reliability `/goal` Prompt](prompts/group-chat-reliability-goal.md)
  — retained scoped prompt for a reliability-only objective, not the active
  umbrella roadmap.

Do not create a second current roadmap, gap-analysis log, or loop-state file.
The stable phase and safety contract belongs in `long-term-development-constraints.md`;
the stable delivery and handoff contract belongs in
`long-term-development-delivery.md`;
stable product decisions belong in `design-decisions.md`; current evidence,
phase status, and the exact next slice belong only in
`long-running-goal-state.md`.

Historical development material is preserved under [`archive/`](archive/):

- retired handoffs and loop checkpoints: [`archive/loop/`](archive/loop/);
- superseded plans and execution contracts: [`archive/plans/`](archive/plans/);
- previous `/goal` prompts: [`archive/prompts/`](archive/prompts/);
- gap analyses and direction reviews: [`archive/reviews/`](archive/reviews/).

The active root set intentionally contains canonical domain docs, the delivery
contract, the current checkpoint, and the two scoped execution prompts above.

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
