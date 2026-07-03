# Delivery Checklist

Use this checklist when moving from design to implementation.

## Repository

- [ ] README explains the project.
- [ ] AGENTS.md defines contribution rules.
- [ ] docs directory has architecture and MVP plan.
- [ ] `.env` is ignored.
- [ ] GitHub repository exists.

## Loop Engineering Readiness

- [ ] `loop-engineering-prep.md` explains execution model and gates.
- [ ] `docs/prompts/loop-goal-lethebot-mainline.md` is current.
- [ ] `loop-state.md` is updated before/after long loop runs.
- [ ] Contracts are explicit enough for agent implementation.
- [ ] Test strategy exists before large implementation loops.
- [ ] Fast path / risk path / background path are reflected in code tasks.

## MVP Readiness

- [ ] Internal event model is defined.
- [ ] OneBot gateway is selected.
- [ ] SQLite schema is drafted.
- [ ] Pi SDK adapter interface is drafted.
- [ ] Tool registry interface is drafted.
- [ ] Memory lifecycle states are implemented.
- [ ] Basic governance command exists.

## Privacy Readiness

- [ ] Memory records include source metadata.
- [ ] Delete disables retrieval immediately.
- [ ] Raw event retention is configurable.
- [ ] Secrets are stored outside git.
- [ ] Tool calls are audited.

