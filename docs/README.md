# LetheBot Documentation

This directory contains the initial design deliverables for LetheBot.

## Reading Order

1. [Vision](vision.md)
2. [Architecture](architecture.md)
3. [Architecture Flow Overview](architecture-flow-overview.md)
4. [Design Decisions](design-decisions.md)
5. [Architecture Weight Assessment](architecture-weight-assessment.md)
6. [Loop Engineering Preparation](loop-engineering-prep.md)
7. [Agent Governance](agent-governance.md)
8. [Memory System](memory-system.md)
9. [Identity Model](identity-model.md)
10. [Context Orchestration](context-orchestration.md)
11. [Social Action Model](social-action-model.md)
12. [Tool Registry](tool-registry.md)
13. [Pi Integration](pi-integration.md)
14. [MVP Roadmap](mvp-roadmap.md)
15. [Tech Stack](tech-stack.md)
16. [Data Model](data-model.md)
17. [Security and Privacy](security-privacy.md)
18. [Operations](operations.md)
19. [Delivery Checklist](delivery-checklist.md)

## Loop Engineering Materials

- [Loop Engineering Preparation](loop-engineering-prep.md) - Strategy for long-running `/goal` implementation
- [Mainline `/goal` Prompt](prompts/loop-goal-lethebot-mainline.md) - Copy-paste starter prompt
- [Loop State](loop-state.md) - Mutable checkpoint for loop execution
- [Contracts](contracts.md) - TypeScript interfaces and schemas
- [Fake Gateway Design](fake-gateway-design.md) - Test harness for Phase D+
- [Test Strategy](test-strategy.md) - P0 regression tests and acceptance criteria
- [SQLite Schema](sqlite-schema.md) - Complete P0 database schema
- [Detailed Phase Tasks](detailed-phase-tasks.md) - Bite-sized implementation tasks
- [Escalation Checklist](escalation-checklist.md) - Decisions agent must ask user about

## Discussion Backlog

- [Discussion Boundaries and Question Backlog](discussion-boundaries-and-questions.md) — 中文讨论问卷，用于逐项决定 LetheBot 的产品身份、记忆边界、群聊策略、Pi 集成、治理权限和 MVP 范围。
- [Answer Review Discussion Log](answer-review-discussion-log.md) — D1-D8 逐题讨论记录。已确认结论已拆入正式设计文档；此文件保留完整推理和取舍过程。

## Design Center

LetheBot should be easy to experiment with, but hard to make opaque. The system can learn aggressively in the background, but durable memory must remain inspectable, editable, and deletable.

