# AGENTS.md

This file defines working rules for AI agents and humans contributing to LetheBot.

## Project Intent

LetheBot is a persistent, local-first chatbot with a thick, governable memory layer and a Pi-based reasoning core. The first practical target is QQ private chat and group chat through NapCat / OneBot.

Optimize for:

- Clear module boundaries.
- Auditable memory behavior.
- User-controlled privacy and deletion.
- Fast experimentation with tools and sandboxes.
- Small, reversible implementation steps.

Avoid:

- Treating memory as only a vector store.
- Hiding prompt/context injection decisions.
- Writing irreversible memory without source metadata.
- Mixing platform adapters, memory logic, and agent reasoning in one module.
- Premature multi-platform abstraction before QQ works.

## Communication Style

- Be direct and technical.
- Answer questions before changing files.
- State assumptions when product behavior is ambiguous.
- Prefer concise plans for multi-step work.
- When disagreeing with a proposal, say so explicitly and explain why.

## Engineering Rules

- Read the relevant docs in `docs/` before changing related code.
- Keep changes scoped to the requested feature or design area.
- Do not remove intentional functionality without asking.
- Do not hardcode secrets, API keys, account IDs, or private QQ identifiers.
- Do not add memory writes that cannot be traced back to source events.
- Prefer explicit data schemas over ad hoc JSON blobs for durable storage.
- Prefer top-level imports in TypeScript. Avoid dynamic imports unless the integration requires plugin loading.
- Avoid `any` in TypeScript. Use `unknown` and narrow it.
- Keep background workers idempotent where possible.
- Treat dependency and lockfile changes as reviewed code.

## Architecture Rules

- Gateway code only adapts platform protocols.
- Ingestion normalizes events and writes raw logs.
- Memory extraction produces proposals before durable long-term facts.
- Context orchestration owns retrieval, ranking, token budgeting, and prompt assembly.
- Pi owns reasoning, tool calling, and turn execution.
- Tools must be registered through a tool registry and audited.
- Governance UI/CLI must be able to inspect and delete long-term memory.

## Privacy Rules

- Store memory by scope: global, user, group, conversation, tool, or system.
- Every long-term memory record must include owner/scope, source, timestamp, confidence, and lifecycle state.
- Deletion must affect retrieval immediately.
- Keep raw event retention configurable.
- Prefer local storage by default.

## Git Rules

- Do not commit unless the user asks or the task explicitly requires repository setup.
- Stage explicit paths only.
- Write concise commit messages.
- Never commit generated secrets, local logs, SQLite databases, or `.env` files.

## Verification

When code exists:

- Run the narrowest relevant tests after changing behavior.
- Run type/lint checks before finishing code changes.
- If no test command exists yet, document what was manually verified.

