# Escalation Checklist

This document lists decisions that the implementing agent **must escalate to the user** rather than deciding independently. These are ambiguous product, security, or technical-debt decisions where the agent's judgment is insufficient.

Phase labels in example prompts are illustrative only. Current authority,
requirement status, and blockers come from `long-running-goal-state.md`; no
remote host, credential, provider call, or QQ session is assumed available.

---

## Product Decisions

### Memory Auto-Activation Thresholds

**Resolved default:** D11 fixes private auto-active confidence at `0.85` and
requires group-derived user memory to remain `same_group_only` and `proposed`.
Do not re-escalate those defaults during the active reliability repair.

Escalate only a requested change to that product policy, a new memory class that
does not fit the existing risk model, or evidence that the locked policy creates
a privacy/integrity contradiction.

### Cooldown Values

**Resolved repair policy:** D9 makes strong `@bot`, reply-to-bot, and command
candidates bypass the local base cooldown. Unmentioned questions use a
15-second delay, 120-second thread window, two interventions per group per ten
minutes, and suppression above five messages per ten seconds or after a human
answer.

Escalate only when adding a new throttle dimension, changing those locked
values, or deciding how a new proactive action shares the group budget.

### Platform Admin Boundary

**What:** Which QQ operations require `platform_admin` capability?

**Agent must ask:**
- Is setting group card platform_admin? (probably yes)
- Is kicking/muting platform_admin? (definitely yes)
- Is creating group invitation links platform_admin? (probably yes)
- Is reading group member list platform_admin? (probably no)

**Example escalation:**
```
Need to classify these OneBot operations for tool registry:
- get_group_member_list: platform_admin or network?
- set_group_card: platform_admin or sends_message?
- set_group_ban: platform_admin (confirmed)
- create_group_invite: platform_admin or network?

Please confirm which capabilities apply.
```

---

## Security Decisions

### Real Pi API Key in Tests

**What:** Should tests use a real model API?

**Agent must ask:**
- Is a real provider call explicitly authorized for this task?
- Is `PI_API_KEY` supplied through the reviewed process environment?
- Which opt-in provider test/runbook and evidence boundary is authorized?

**Example escalation:**
```
The remaining LIVE requirement needs a controlled real-provider run.

Options:
A. Authorize the documented opt-in real-provider run with explicit environment injection
B. Keep real-provider evidence blocked; continue credential-free deterministic work
C. Explicitly reduce scope and do not claim the original production-ready objective

Which approach?
```

### Real SnowLuma / NapCat / QQ Connection

**What:** Is a controlled real OneBot/QQ session authorized and available?

**Agent must ask:**
- Is local SnowLuma/NapCat/QQ login and message interaction authorized?
- Which controlled bot account/group and Framework runbook may be used?
- Is the check manual/local only, with redacted evidence kept outside the repo?

**Example escalation:**
```
Real SnowLuma / OneBot / QQ acceptance

Options:
A. Authorize the controlled local Framework flow and redacted evidence collection
B. Keep LIVE blocked and continue remaining local deterministic work
C. Explicitly reduce scope; FakeOneBot remains deterministic evidence only

Which requirement?
```

### Audit Log Retention

**Resolved defaults:** D11 sets 90 days for raw/chat/failure evidence, 365 days
for audit, and 90 days for rejected/disabled/deleted memory. Existing immediate
retrieval exclusion, user deletion, tombstone, and secret-redaction contracts
still apply.

Escalate a change to these periods, full-purge/tombstone semantics, a legal or
regulatory requirement, or a new storage class without an existing retention
owner. Routine implementation of the locked values does not require another
product question.

---

## Technical Debt Decisions

### Test Requires Real Credentials but Missing

**What:** A required live check needs a credential/session that is unavailable or unauthorized.

**Agent must ask:**
- Is the exact external action authorized now?
- Should the opt-in test remain skipped with the blocker recorded?
- Is there other independent local work to finish before declaring `BLOCKED_EXTERNAL`?

**Example escalation:**
```
LIVE real-provider evidence requires `PI_API_KEY`, but no authorized credential is available.

Options:
A. Authorize and provide the explicit environment for the opt-in run
B. Keep the opt-in test skipped and record `BLOCKED_EXTERNAL` only after local work is exhausted
C. Explicitly reduce scope; do not count mock evidence as a real-provider pass

Current recommendation: B unless the user explicitly authorizes A.

Confirm or override?
```

### Boundary Simpler Than Design

**What:** Implementation discovers that a boundary is simpler to implement without full separation.

**Agent must ask:**
- Should we merge the modules for P0 and preserve interface separation?
- Or should we maintain full physical separation even if it adds complexity?

**Example escalation:**
```
Context Orchestrator + Memory Retrieval

Implementation note: ContextBuilder and MemoryRetrieval are tightly coupled and both small.

Options:
A. Keep separate files: context-builder.ts + memory-retrieval.ts
B. Merge into single file: context/index.ts with clear internal boundaries
C. Merge now, split later if either grows large

Recommendation: B (merge with clear comments, interface stays separate)

Confirm?
```

### Conflicting Design Docs

**What:** Two design docs give conflicting guidance.

**Agent must ask:**
- Which doc is authoritative?
- Should both be updated for consistency?

**Example escalation:**
```
Conflict found:

- architecture.md says: "Attention Engine outputs fast classification signals"
- social-action-model.md says: "SocialDecisionService constructs ActionDecision after Pi and optional evaluator review"

contracts.md resolved this as: Attention classifies, Pi supplies a candidate
response, and SocialDecisionService owns the durable ActionDecision.

Should I update architecture.md and social-action-model.md to match contracts.md?

Or is there a nuance I'm missing?
```

---

## Loop Control Decisions

### Context Degradation

**What:** Context usage is high (>70%), should agent stop?

**Agent must ask:**
- Checkpoint current progress and stop cleanly?
- Or continue if the current verified slice is almost done?

**Example escalation:**
```
Context usage: 72% (DEGRADING tier)

Current slice: Attention execution-profile wiring
Progress: 4/5 tasks complete, last task is small (update tests)

Options:
A. Checkpoint now, stop, write handoff
B. Finish the current slice, verify it, then reassess the critical path
C. Open another slice immediately (risk quality degradation)

Recommendation: B

Confirm?
```

### Repeated Test Failure

**What:** Same test fails 3 times with different fixes attempted.

**Agent must ask:**
- Is this a design issue, not an implementation bug?
- Should we simplify the requirement?
- Or is there a missing dependency/environment issue?

**Example escalation:**
```
Test failed 3 times: "private_only memory not injected into group context"

Attempts:
1. Fixed visibility filter in context-builder -> still fails
2. Fixed memory retrieval query -> still fails
3. Added debug logging -> memory IS excluded, but test assertion wrong

Root cause: Test expected a filtered marker inside
ContextPack.memory.retrievedFacts, but current ContextBuilder hard-excludes
inaccessible memory before token selection and records rejection evidence in
the context trace instead.

Options:
A. Change the test to assert exclusion from retrievedFacts and inspect the trace
B. Change the documented context contract and implementation together
C. Clarify whether a different operator-only rejection view is required

Need design clarification.
```

---

## When to Escalate

**Escalate immediately when:**
- Design docs conflict and agent can't resolve
- Security/privacy boundary is ambiguous
- Test requires real credentials that are missing
- Product behavior threshold (cooldown, confidence, etc.) is not specified
- Implementation reveals design assumption was wrong
- Test fails repeatedly and root cause is unclear

**Do NOT escalate for:**
- Routine implementation decisions (variable names, file organization within a module)
- Bug fixes with clear root cause
- Test failures with obvious fix
- Choosing between equivalent approaches (unless design docs specify otherwise)

**Examples of when NOT to escalate:**

✅ **Don't escalate these:**
- Choosing `getUserId()` vs `getCanonicalUserId()` as function name → pick the clearer one
- Putting MemoryRepository in `src/memory/repository.ts` vs `src/memory/repo.ts` → use full name
- Using `async/await` vs `.then()` chains → prefer async/await for consistency
- Adding a debug log line → add it
- Fixing a typo in a comment → fix it
- Choosing between two equivalent SQL index strategies → pick the simpler one

❌ **MUST escalate these:**
- Changing the locked D11 memory threshold or group-derived-memory policy → escalate
- Changing the locked D9 delay, thread, traffic, or intervention limits → escalate
- Classifying a QQ operation as platform_admin or not → escalate
- Handling missing Pi API key (block, skip, or mock?) → escalate
- Resolving conflicting guidance between two design docs → escalate

---

## Escalation Format

When escalating, agent should:
1. State the decision that needs to be made
2. Provide 2-3 concrete options (A, B, C)
3. Give a recommendation with rationale
4. Ask for confirmation or override
5. Do NOT continue implementation until user responds
