# Escalation Checklist

This document lists decisions that the implementing agent **must escalate to the user** rather than deciding independently. These are ambiguous product, security, or technical-debt decisions where the agent's judgment is insufficient.

---

## Product Decisions

### Memory Auto-Activation Thresholds

**What:** When is memory auto-activated vs proposed?

**Agent must ask:**
- What confidence threshold triggers auto-activation? (e.g., >0.8)
- What counts as "low risk" vs "medium risk" memory?
- Is group-derived user preference medium-risk or high-risk by default?

**Example escalation:**
```
I need to decide when to auto-activate memory. Current design says:
- Low-risk: auto-active
- Medium-risk: auto-active with conservative visibility
- High-risk: proposal/admin digest

For "user prefers short replies" extracted from group chat:
- Is this medium-risk (auto-active with same_group_only visibility)?
- Or high-risk (proposal first)?

Please clarify the risk threshold.
```

### Cooldown Values

**What:** How long is "just spoke" for cooldown?

**Agent must ask:**
- Cooldown for bot's own messages in group? (e.g., 60 seconds)
- Cooldown for same-user repeated @bot? (e.g., 10 seconds)
- Cooldown for high-speed chat suppression? (e.g., >5 messages/10sec)

**Example escalation:**
```
Need concrete cooldown durations:
1. Bot replied in group -> wait ___ seconds before replying again
2. Same user @bot twice -> wait ___ seconds between replies
3. Group high-speed chat (>___ msg/10sec) -> suppress proactive replies

Please provide specific durations or confirm defaults:
- Own message cooldown: 60s
- Repeated mention: 10s
- High-speed threshold: 5 msg/10sec
```

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
- Is it acceptable to call real Pi/OpenAI API during Phase G tests?
- Should we require env var (e.g., `LETHEBOT_PI_API_KEY`) to be set explicitly?
- Or should Phase G tests use mock Pi only, with real API in Phase M?

**Example escalation:**
```
Phase G acceptance requires testing Pi SDK adapter with real model.

Options:
A. Use real API if LETHEBOT_PI_API_KEY is set, skip test otherwise
B. Use mock Pi only; defer real API to Phase M
C. Require real API key for Phase G to pass

Which approach?
```

### Real NapCat Connection

**What:** Should Phase E connect to real NapCat on arqelvps?

**Agent must ask:**
- Is Phase E acceptance blocked on real NapCat connection?
- Or can Phase E pass with FakeOneBot only, and defer real connection to Phase M?
- If real connection required: should it be in CI or manual verification only?

**Example escalation:**
```
Phase E: NapCat / OneBot adapter

Can pass with:
A. FakeOneBot tests only (real connection deferred to Phase M)
B. Manual real NapCat smoke test on arqelvps (not in CI)
C. Automated real NapCat integration test (requires arqelvps access in CI)

Which requirement?
```

### Audit Log Retention

**What:** How long to keep full audit logs?

**Agent must ask:**
- Default retention for raw_events? (e.g., 30 days, 90 days, forever)
- Default retention for audit_log full-level entries? (e.g., 7 days)
- Is there a GDPR/privacy consideration for raw QQ message retention?

**Example escalation:**
```
Need audit retention policy:

1. raw_events (contains full message text):
   - Retain: ___ days (or forever)
   - Configurable via LETHEBOT_RAW_EVENT_RETENTION_DAYS

2. audit_log (level=full, contains tool I/O):
   - Retain: ___ days
   - Owner/admin-only access

3. Privacy consideration:
   - Users can request their raw_events deletion?
   - Or raw_events are audit-only and not deletable?

Please define retention and deletion policy.
```

---

## Technical Debt Decisions

### Test Requires Real Credentials but Missing

**What:** Phase acceptance test needs real credential (Pi API key, NapCat, etc.) but it's not available.

**Agent must ask:**
- Should the phase be blocked until credential is provided?
- Or should the test be marked `test.skip()` with a clear reason?
- Or should we implement a degraded acceptance (mock-only)?

**Example escalation:**
```
Phase G acceptance test requires real Pi API key, but LETHEBOT_PI_API_KEY is not set.

Options:
A. Block Phase G, wait for credential
B. Skip test with warning: "Skipped: no real Pi API key"
C. Pass with mock Pi only (degraded acceptance)

Current recommendation: B (skip with warning, note in phase-acceptance.md)

Confirm or override?
```

### Boundary Simpler Than Design

**What:** Implementation discovers that a boundary is simpler to implement without full separation.

**Agent must ask:**
- Should we merge the modules for P0 and preserve interface separation?
- Or should we maintain full physical separation even if it adds complexity?

**Example escalation:**
```
Phase H: Context Orchestrator + Memory Retrieval

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

- architecture.md says: "Attention Engine outputs action candidates"
- social-action-model.md says: "Pi outputs ActionDecision"

contracts.md resolved this as: Attention does fast classification only; Pi outputs ActionDecision.

Should I update architecture.md and social-action-model.md to match contracts.md?

Or is there a nuance I'm missing?
```

---

## Loop Control Decisions

### Context Degradation

**What:** Context usage is high (>70%), should agent stop?

**Agent must ask:**
- Checkpoint current progress and stop cleanly?
- Or continue if current phase is almost done?

**Example escalation:**
```
Context usage: 72% (DEGRADING tier)

Current phase: Phase F (Attention + execution profiles)
Progress: 4/5 tasks complete, last task is small (update tests)

Options:
A. Checkpoint now, stop, write handoff
B. Finish Phase F (one small task left), then stop
C. Continue to Phase G (risk quality degradation)

Recommendation: B (finish Phase F first)

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

Root cause: Test expects memory to be excluded from ContextPack.memory.retrievedFacts,
but current design allows it in retrievedFacts with a "filtered" flag.

Options:
A. Change test to check for "filtered" flag
B. Change implementation to hard-exclude from retrievedFacts
C. Clarify design: should filtered memories be in retrievedFacts or not?

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
- Choosing memory auto-activation confidence threshold (0.7? 0.8? 0.9?) → escalate
- Deciding if group-derived user preference is medium or high risk → escalate
- Setting cooldown duration in seconds → escalate
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