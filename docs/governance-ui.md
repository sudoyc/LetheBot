# Local Governance Experience

This document is the canonical P8 contract for the local owner/admin HTTP and
browser experience. It defines product tasks, information architecture,
security boundaries, service ownership, and verification.

Current implementation also includes configured-retention preview-confirm in the
Operations view. It is an authenticated, exact same-origin, CSRF-protected,
system-scoped mutation using a separate closure-private browser authority. The
preview displays only configured days, aggregate effects, terminal memory states
(`rejected`, `disabled`, `deleted`), and the irreversible hard-delete/no-rollback
boundary. Candidate IDs, fingerprints, digest, database paths, SQL, and the
opaque handle are never rendered, announced, logged, or placed in browser
storage. Refresh, navigation, logout/session expiry, replacement preview, and
timer expiry clear authority; confirm consumes it before dispatch and requires a
fresh preview after every failure.

The configured defaults are raw/chat/event-processing-failure 90 days, audit 365
days, and terminal memory 90 days; `0` means forever. Active memory is excluded.
A verified backup is recommended but is not a confirmation prerequisite.

The historical slice ledger below is retained as implementation provenance;
statements that a later route or browser control "remains absent" describe that
slice boundary, not the current aggregate implementation.

Current status: the A0 contract, isolated A1 listener/session/CSRF/scope
boundary, A2 default-off configuration/application lifecycle wiring, B1 shared
aggregate overview query, B2A shared legacy memory-review reads, and B2B
exact-scope normalized maintenance-review projections, and B3 bounded redacted
maintenance-review scope catalog, and the standalone B4 session-bound scope-
handle registry, B5A HTTP session-lifecycle ownership, and the B5B authenticated-
unscoped route boundary exist with deterministic tests. B5C now binds the
catalog to session-bound handle issuance and registers only authenticated `GET
/governance/api/v1/scopes`. B6A additionally exposes the existing system-wide
aggregate health projection at authenticated `GET /governance/api/v1/overview`.
B6B registers the exact-scope, read-only maintenance-review list at `GET
/governance/api/v1/memory-reviews`. B6C adds session/scope/purpose-bound
resource handles to that list and registers only the corresponding read-only
detail at `GET /governance/api/v1/memory-reviews/<resource-handle>`. B7A adds a
standalone short-lived, single-use confirmation-preview handle registry. B7B
subordinates it to the existing HTTP session lifecycle and application
ownership. B7C adds only the pending-review approval preview at authenticated
`POST /governance/api/v1/memory-reviews/<resource-handle>`. B7D adds the matching
authenticated approval confirmation at
`POST /governance/api/v1/memory-reviews/<resource-handle>/confirm`; memory
application, rollback, other mutation families, and browser routes remain absent.
B8A adds the matching pending-review rejection preview to the existing detail
POST. B8B adds rejection confirmation through the existing `/confirm` route;
B9A adds a bounded preview for the existing governed maintenance-application
operation. B9B adds exact application confirmation through that existing
governed operation. B10A adds a bounded rollback preview for applied maintenance
proposals. B10B adds exact rollback confirmation through the existing governed
operation. B11A adds a bounded pending-review expiration preview; expiration
confirmation is added in B11B through the existing governed review transition.
B12A moves the existing bounded audit-inspection read and redacted DTO into
`GovernanceQueryService`, with `GovernanceCLI` delegating to that shared method.
B12B likewise moves the existing exact memory record/source/revision/audit
provenance read and redaction into the shared service while preserving the CLI
result. B12C-B12G move the existing memory list/export, model-invocation
summary, tool-call inspection, and action-decision inspection behind the same
typed boundary. B12H moves bounded action-execution inspection and its pure row
projector into that service while preserving context-explanation ordering.
B12I now moves bounded job inspection and its pure row projector into the same
service. B12J moves bounded job-attempt inspection and its pure row projector
into that service. B12K moves bounded worker-heartbeat inspection and its pure
row projector into that service. B12L moves bounded event-processing-failure
inspection and its pure row projector into that service. B12M moves bounded
privacy-preference inspection and its fixed redacted projection into that
service. B13A moves the stored Explain/context-trace read over
`ContextTraceRepository.findByTurnId` and its pure fixed projection into the
same service; `GovernanceCLI` delegates that read without rebuilding a context.
B13B moves the bounded Explain action-decision, action-execution, and tool-call
reads and pure projections into the same service; `GovernanceCLI` delegates
them while preserving linked-decision selection, ascending evidence order,
redaction, and reaction effect labels. These HTTP and browser routes remain
absent. B13C moves the explicit/latest Explain turn-resolution read and its
joined conversation metadata projection into the same service; `GovernanceCLI`
delegates it while preserving validation, canonical-user inference, rebuild
inputs, and stored-trace preference. These HTTP and browser routes remain
absent. B14A exposes the existing payload-free model-invocation aggregate at
authenticated `GET /governance/api/v1/activity/model-invocations`; it accepts
no query, body, or scope header and returns the typed
`GovernanceQueryService.summarizeModelInvocations()` projection without raw
invocation identifiers, prompts, responses, or provider payloads.
B14B exposes the existing bounded default worker-heartbeat list at authenticated
`GET /governance/api/v1/activity/worker-heartbeats`. It accepts no query, body,
or scope header, calls `GovernanceQueryService.listWorkerHeartbeats()` without
options, keeps details absent, and returns only recursively redacted worker,
worker-type, current-job, status, and heartbeat-time fields.
B14C completes the first jobs/workers read pair with authenticated
`GET /governance/api/v1/activity/jobs`. It accepts no query, body, or scope
header, calls `GovernanceQueryService.listJobs()` without options, keeps payload
and result absent, and returns only the bounded recursively redacted operational
projection.
B14D adds the existing bounded default tool-call list at authenticated
`GET /governance/api/v1/activity/tool-calls`. It accepts no query, body, or scope
header, calls `GovernanceQueryService.listToolCalls()` without options, keeps
input and output absent, and returns only the recursively redacted operational
and diagnostic projection.
B14E adds the existing bounded default action-decision list at authenticated
`GET /governance/api/v1/activity/action-decisions`. It accepts no query, body,
or scope header, calls `GovernanceQueryService.listActionDecisions()` without
options, keeps actions absent, and returns only the recursively redacted
decision projection.
B14F completes the bounded action-history pair with authenticated
`GET /governance/api/v1/activity/action-executions`. It accepts no query, body,
or scope header, calls `GovernanceQueryService.listActionExecutions()` without
options, keeps audit entries absent, and returns only the recursively redacted
execution projection.
B14G completes bounded job execution history with authenticated
`GET /governance/api/v1/activity/job-attempts`. It accepts no query, body, or
scope header, calls `GovernanceQueryService.listJobAttempts()` without options,
keeps results absent, and returns only the recursively redacted attempt
projection.
B14H adds bounded failure triage at authenticated
`GET /governance/api/v1/activity/event-processing-failures`. It accepts no
query, body, or scope header, calls
`GovernanceQueryService.listEventProcessingFailures()` without options, keeps
details absent, and returns only the recursively redacted hash-backed failure
projection.
B14I completes the audit/failure pair at authenticated
`GET /governance/api/v1/activity/audit`. It accepts no query, body, or scope
header, calls `GovernanceQueryService.listAudit()` without options, keeps details
absent, and returns only the recursively redacted audit projection and explicit
redaction signals.
B15A adds an HTTP-disabled Privacy user-scope catalog to
`GovernanceQueryService`. It reads canonical users in stable newest-seen order,
passes only an exact user scope to a trusted handle issuer, and returns at most
100 fixed identifier-free entries with explicit truncation. No Privacy route,
preference mutation, or maintenance-review handle behavior changes.
B15B adds an HTTP-disabled exact-user Privacy preference page to the same
service. It applies the resolved user scope through the existing bounded read,
returns only preference state, redacted reason and updater classification, and
dates, and removes canonical owner/updater identifiers. No Privacy route or
preference mutation is added.
B15C exposes only the B15A catalog at authenticated
`GET /governance/api/v1/privacy/scopes`. It rejects query strings and scope
headers, binds every issued exact-user handle to the current session, expiry,
and `governance.privacy.preferences.read`, and leaves all Privacy mutations
HTTP-disabled.
B15D exposes only the B15B page at exact-scope
`GET /governance/api/v1/privacy/preferences`. The shared boundary rejects
queries and missing, malformed, unknown, cross-session, or cross-purpose
handles before the callback; the handler passes only the resolved scope to B15B.
B24C exposes only the B24B catalog at authenticated
`GET /governance/api/v1/group-summary/scopes`. It rejects query strings and
scope headers, binds every issued exact-group handle to the current session,
expiry, and `governance.group_summary_policy.status.read`, and leaves status
and mutation routes absent.
B24D exposes only the B24A projection at exact-scope read-only
`GET /governance/api/v1/group-summary/policy`. The shared boundary rejects
queries and missing, malformed, unknown, cross-session, or cross-purpose
handles before the callback; the handler passes only the resolved group scope
to B24A. B24G adds mutation-marked `POST` at the same path. It accepts only exact
`{ "action": "change", "targetState": STATE }` after the existing
authentication, Origin/CSRF, JSON, query, and exact-scope checks, returns only
the B24E write-free projection plus fresh current-session authority. B24H adds
separate mutation-marked `POST` at `/group-summary/policy/confirm`, consumes
matching authority once, recomputes B24E, and invokes only B24F.
B26D exposes only the B26A catalog at authenticated
`GET /governance/api/v1/display-profile/scopes`. It rejects queries and scope
headers, binds every issued exact-user handle to the current session, expiry,
and `governance.display_profile.targets.read`. B26E exposes only the B26C page
at exact-scope read-only `GET /governance/api/v1/display-profile/targets`. It
passes only the resolved exact-user scope to B26C and binds each returned
target handle to the current session and expiry, the same read purpose, resource
kind `display_profile_target`, B26C's full internal target ID, and that exact
scope. Read-only
`GET /governance/api/v1/display-profile/targets/<resource-handle>` requires that
same scope authority, resolves the resource against the current session,
purpose, kind, and exact scope, and returns only the bounded redacted shared
target detail. Missing detail is concealed as `404`. Mutation-marked `POST` at
that same path accepts only `{ "action": "redact" }`, calls the write-free
full-row preview, and returns it with fresh current-session action authority.
Mutation-marked `POST` at that resource path plus `/confirm` accepts only the
fixed confirmation body, consumes matching authority once, recomputes the exact
preview, resolves the trusted internal mutation selectors, and invokes only the
shared atomic expected-snapshot redaction. Unknown authority is concealed;
reused, drifted, or stale authority conflicts. Success returns only identifier-
free counts, redaction time, effects, audit evidence, and the irreversible
rollback boundary.
B16A adds an HTTP-disabled Memory-record scope-handle catalog to
`GovernanceQueryService`. It reads distinct valid exact scopes represented by
memory records in every lifecycle state, passes only each normalized scope to a
trusted handle issuer, and returns at most 100 fixed identifier-free entries
with explicit truncation. Tool records remain omitted because the durable
memory schema has no exact tool-name selector. No Memory route or mutation is
added.
B16B exposes only that catalog at authenticated
`GET /governance/api/v1/memory/scopes`. It rejects query strings and scope
headers, binds every issued exact-scope handle to the current session, expiry,
and `governance.memory.records.read`, and leaves all Memory data/detail routes
HTTP-disabled.
B16C adds the corresponding HTTP-disabled exact-scope Memory-record page. It
queries every lifecycle state behind one fixed 100-row bound and returns only
opaque record references, bounded redacted or fixed-hidden text, classifications,
scores, source/revision counts, and dates. Raw record, owner, source, subject,
and evaluator identifiers remain absent, and no Memory data route is added.
B16D exposes only that page at exact-scope
`GET /governance/api/v1/memory/records`. The shared boundary rejects queries and
missing, malformed, unknown, cross-session, or cross-purpose handles before the
callback; the handler passes only the resolved scope to B16C. Memory detail and
mutation routes remain HTTP-disabled.
B17A adds the corresponding HTTP-disabled exact-scope Memory provenance detail
to `GovernanceQueryService`. It matches the internal record ID and complete
scope tuple before reading bounded source, revision, or audit evidence, reuses
the B16C record projection, and returns only fixed redacted references,
classifications, dates, and truncation signals. It issues no handle and
registers no HTTP route.
B17B adds a separate HTTP-disabled resource-handle page over the exact B16C
selection. It passes only each selected internal record ID and normalized scope
to a trusted issuer, copies back only the opaque handle and numeric expiry, and
leaves the B16D response, registry wiring, and detail routes unchanged.
B17C changes only the existing B16D route delegation to that B17B page. The
application issuer binds each selected internal record ID and normalized scope
to the callback's current session digest and expiry, the existing Memory-read
purpose, and resource kind `memory_record`; Memory detail remains HTTP-disabled.
B17D registers read-only `/memory/records/:resourceHandle` with that same
purpose and kind. The shared boundary resolves both handles before the callback,
which passes only the exact scope and internal record ID to B17A; no Memory
mutation route is added.
B18A adds an HTTP-disabled Explain conversation-scope handle catalog to
`GovernanceQueryService`. It discovers only valid private/group conversations
with a stored trace consistent with its linked turn, passes only each exact
conversation scope to a trusted issuer, and returns at most 100 fixed
identifier-free entries with explicit truncation. No Explain route, trace
rebuild, or CLI change is added.
B18B exposes only that catalog at authenticated
`GET /governance/api/v1/explain/scopes`. It rejects query strings and scope
headers, binds every issued exact-conversation handle to the current session,
expiry, and `governance.explain.turns.read`, and leaves every Explain data route
HTTP-disabled.
B18C adds only an HTTP-disabled exact-conversation turn-summary page. It selects
distinct turns that have a structurally matching stored trace inside the exact
private/group scope, probes 101 rows before returning at most 100, and orders by
turn start then turn ID. Each entry contains only a domain-separated
fingerprint, fixed label and stored-trace marker, finite known status, start
time, and optional completion time. Raw identifiers, context, actions, tools,
Provider fields, responses, tokens, handles, rebuilds, and routes remain absent.
B18D exposes only that page at exact-scope
`GET /governance/api/v1/explain/turns`. The shared boundary rejects queries and
missing, malformed, unknown, cross-session, or cross-purpose handles before the
callback; the handler passes only the resolved exact conversation scope to
B18C. Explain detail, resource, rebuild, and mutation routes remain absent.
B19A adds only an HTTP-disabled Explain-turn resource-handle page. It reuses
B18C's exact bounded row selector, passes only each normalized conversation
scope and selected internal turn ID to a trusted issuer, and adds only an opaque
handle and numeric expiry to the unchanged turn DTO. B18D's response, registry
wiring, and all Explain detail routes remain unchanged.
B19B changes only B18D's existing list delegation to B19A. The trusted issuer
binds each selected turn to the callback's current session digest/expiry,
`governance.explain.turns.read`, resource kind `explain_turn`, and B19A's
normalized exact scope. The list returns that fixed handle-bearing page; no
Explain detail, resource-detail, rebuild, or mutation route is added.
B19C adds only an HTTP-disabled exact-conversation Explain-turn detail method.
It proves the clean internal turn ID and requested private/group scope against
the turn's linked stored context before selecting the newest matching trace,
then returns bounded identifier-free context, decision/execution, and tool
summaries. It does not resolve a handle, rebuild context, or add a route.
B19D exposes only that projection at exact-scope read-only
`GET /governance/api/v1/explain/turns/<resource-handle>`. The shared boundary
requires the current session's Explain-read scope and `explain_turn` resource
authority before passing only the resolved scope and internal turn ID to B19C.
A resolved missing detail maps to fixed `404`; ContextBuilder rebuild and every
Explain mutation route remain absent.

## Product Boundary

The governance experience is an optional local operations surface. It must:

- use a dedicated listener that is disabled independently of the application
  health, metrics, and OneBot listener;
- bind only to an exact loopback address during P8;
- authenticate an HTTP admin independently of QQ account roles;
- use the existing governance, repository, and operations owners instead of
  issuing SQL from HTTP or browser code;
- default to bounded, redacted projections rather than database rows;
- preserve CLI and QQ behavior when disabled or rolled back.

The browser is an untrusted client. A loopback peer, a QQ owner/admin role, a
request header that claims a role, and possession of a resource identifier do
not establish an HTTP admin session or scope authority.

## Operator Tasks

The first complete experience supports these tasks in priority order:

1. Triage current health through aggregate model, tool, action, job, worker,
   event-failure, and review counts without opening raw payloads.
2. Review memory maintenance proposals within one explicit scope, inspect the
   candidate snapshot and revision history, then approve, reject, expire, apply,
   or roll back through `GovernanceService`.
3. Find a memory within one explicit scope and inspect its bounded record,
   source, revision, and audit provenance.
4. Explain one exact turn or the latest prior turn in one exact conversation,
   including selected/rejected memory reasons, context budget, actions, and
   tool outcomes.
5. Inspect bounded model invocation, tool call, action, job attempt, worker
   heartbeat, audit, and event-processing evidence.
6. Inspect and change privacy preferences, exact-group summary policy, display
   profile redaction, retention settings, and identity unlinking through their
   existing governed owners.
7. Inspect backup/integrity status, create and verify a private backup through
   the operations owner, and prepare a restore handoff.

An in-process HTTP request must not restore the database that serves it. Restore
requires the existing stopped-service operations procedure. P8 may validate and
prepare a bounded restore plan, but execution remains an out-of-process
maintenance action until a separately reviewed supervisor boundary can stop the
service, close SQLite, restore, verify, and restart it.

## Information Architecture

The primary navigation has five destinations:

| Destination | Default view | Secondary views |
|---|---|---|
| Overview | Aggregate health and pending attention | Recent bounded failures |
| Memory | Records | Review queue, record/source/revision detail |
| Explain | Turn or conversation lookup | Context, action, and tool evidence |
| Activity | Model invocations | Tools/actions, jobs/workers, audit/failures |
| Privacy & Operations | Privacy preferences | Summary policy, retention, backup/restore |

The current scope selector is persistent above page content. It always shows a
scope kind plus a redacted label/fingerprint; an unlabeled broad `all` scope is
not available. Filters, cursor position, and scroll position survive navigation
back to a list. Detail and review pages have stable deep links that use opaque
session-bound handles rather than raw local or platform identifiers.

On viewports at least 1024px wide, primary navigation is a compact left sidebar
and content uses dense tables or definition lists. On smaller viewports,
navigation becomes one labelled menu and tables reflow into labelled rows; the
page must not require horizontal scrolling. Page sections are unframed. Cards
are reserved for repeated review items and modal confirmation content, never
nested inside other cards.

## Shared Application Services

`GovernanceService` remains the authority and mutation boundary for QQ/local
admin memory deletion, exact-group summary policy, and memory maintenance
review/apply/rollback. HTTP handlers must call it with a server-created
`local_admin` actor; they must not accept actor class or invocation context from
the request.

The system-wide aggregate health projection is owned by
`GovernanceQueryService`. The same service owns the existing unscoped
memory-review list and summary projections, review-resolution evidence,
bounded audit, memory-provenance, tool-call, action-decision, and
action-execution reads, structured display redaction, and memory-ID-group
parsing. It also owns the stored Explain projection plus the action/tool Explain
evidence projections for one exact turn, and the explicit/latest turn-resolution
projection with nullable joined conversation metadata. `GovernanceCLI` delegates
those legacy reads to the typed methods. Those legacy reads do not invoke
`ContextBuilder` when a stored trace is present, alter action/tool ordering, or
expose their CLI-oriented DTOs through HTTP; action executions retain the
existing reaction effect labels. B19D separately exposes only B19C's bounded
identifier-free projection without rebuilding context.
B6A exposes only the aggregate projection through authenticated-unscoped
`/overview`, with no request filters or new query semantics.

For the normalized maintenance-review queue, `GovernanceQueryService` owns fixed
list and detail DTOs over the P5 proposal lifecycle. A repository-owned
`exact_scope` predicate supports global, user, group, exact private/group
conversation tuples, and system memory scopes. Scope and lifecycle state are
applied before the maximum 100-row list limit. Detail collections expose at
most 32 candidates and 32 revisions with explicit truncation. Proposal and
memory identifiers become purpose-bound fingerprints; audit/revision IDs,
owner values, raw payloads, and unrestricted fields are absent. The current
memory schema cannot bind a `tool` memory to one tool name, so a tool-name scope
returns no maintenance-review record rather than widening to every tool memory.
B2B registers no HTTP route and issues no scope or resource handle.

B6B exposes the existing pending-review list DTO inside `{ entries, truncated }`.
The HTTP boundary supplies the session-resolved exact scope and accepts no
filter, raw identifier, caller-selected limit, ordering, query string, or body.
One repository-owned count reuses the same exact-scope and lifecycle predicates,
so the fixed maximum-100 page reports omitted rows without widening its scope.

B6C passes each selected proposal's internal ID and normalized exact scope only
to a trusted resource-handle issuer, then adds only `handle` and numeric
`handleExpiresAt` to each list entry. The proposal's optional `expiresAt`
retains its existing lifecycle meaning. Issuer extras, session evidence, raw
proposal IDs, and raw scope fields are not copied into the DTO. The detail route
resolves both handles before calling the existing maximum-32 candidate/revision
projection; a valid binding whose proposal is no longer available returns the
same fixed `404` as every other unavailable resource.

B7C adds one fixed `GovernanceQueryService` projection for approving a
`pending_review` proposal. It contains only the canonical action, purpose-bound
scope fingerprint and proposal reference, proposal/effect kinds, affected count
and fingerprint, current and expected lifecycle state/revision, three fixed
durable review effects, the unavailable memory-record effect, and the explicit
approval rollback boundary. A domain-separated SHA-256 digest covers that exact
payload. Missing, cross-scope, non-pending, and tool-scoped proposals return no
preview, and the projection performs no write.

B7D adds one fixed confirmation projection over the trusted post-transition
proposal returned by `GovernanceService`. It verifies the exact scope, expected
revision, approved lifecycle state, and local-admin approval revision, then
returns only the canonical action, approved outcome, purpose-bound proposal,
revision, and audit references, current revision, the absent memory-record
mutation, and the approval rollback boundary.

B8A adds a distinct fixed rejection projection for the same exact pending-review
resource boundary. It predicts `pending_review@N -> rejected@(N+1)`, reports the
same three review-ledger durable effects and unavailable memory-record mutation,
and states that rejection has no memory-effect rollback. Its action and
domain-separated SHA-256 digest are distinct from approval. Projection remains
read-only and returns no preview for missing, cross-scope, non-pending, or
tool-scoped proposals.

B8B adds the matching fixed rejected-result projection. It verifies the exact
scope, expected revision, rejected lifecycle state, and local-admin rejection
revision returned by `GovernanceService`, then exposes only the canonical
rejection action and outcome, purpose-bound proposal/revision/audit references,
current revision, absent memory-record mutation, and rejection rollback boundary.

B9A adds one fixed application projection for an exact-scope `approved`
proposal. Consolidation and decay derive their effects from the normalized
proposal; conflicts require one candidate's existing 16-character `memoryRef`
as the retained selection. The projection aggregates bounded retained,
superseded, or disabled role counts under role-specific SHA-256 fingerprints,
predicts `approved@N -> applied@(N+1)`, identifies the fixed proposal, audit,
memory-revision, and effect-evidence writes plus immediate retrieval exclusion,
and states that rollback requires a separate confirmation. A distinct
domain-separated SHA-256 digest covers the complete plan. Missing, cross-scope,
non-approved, tool-scoped, kind-incompatible, and invalid-selection inputs return
no preview, and the projection performs no write.

B9B reuses that projection through one trusted application resolver. Only this
internal result carries the raw retained memory ID selected by a conflict
`memoryRef`; the HTTP preview and confirmation DTOs never contain it. The fixed
confirmation projection verifies exact scope, proposal identity, approved
revision, applied lifecycle state, local-admin apply revision, and the original
effect plan, then exposes only redacted proposal/revision/audit references,
affected-role aggregates, retrieval consequences, and the separate rollback
boundary.

B10A adds one fixed rollback projection for an exact-scope `applied` proposal.
It aggregates every candidate under one restored role count and SHA-256
fingerprint, predicts `applied@N -> rolled_back@(N+1)`, identifies the fixed
proposal, audit, memory-revision, and effect-evidence writes plus immediate
active-retrieval restoration, and requires a separate confirmation. A distinct
domain-separated SHA-256 digest covers the complete plan. Missing, cross-scope,
non-applied, and tool-scoped proposals return no preview, and the projection
performs no write or retrieval change.

B10B adds the matching fixed rolled-back result projection. It verifies exact
scope, proposal identity, applied revision, rolled-back lifecycle state,
local-admin rollback revision, and the original restored-role plan, then exposes
only redacted proposal/revision/audit references, affected-record aggregate,
restored retrieval consequence, and terminal `rollback_is_terminal` boundary.

B11A adds a distinct fixed expiration projection for an exact-scope
`pending_review` proposal. It predicts `pending_review@N -> expired@(N+1)`,
reports the same three review-ledger durable effects and unavailable
memory-record mutation as rejection, and states that expiration has no
memory-effect rollback. Its action and domain-separated SHA-256 digest are
distinct from approval and rejection. Projection remains read-only and returns
no preview for missing, cross-scope, non-pending, or tool-scoped proposals.

B11B adds the matching fixed expired result projection. It verifies exact
scope, proposal identity, expected pending revision, expired lifecycle state,
and the local-admin expiration revision, then exposes only redacted
proposal/revision/audit references, no memory-record mutation, and the terminal
`expiration_does_not_apply_memory_effects` boundary.

For later review-scope issuance, `GovernanceQueryService` also owns a fixed
catalog over distinct exact scopes represented by normalized maintenance
proposals in any lifecycle state. SQL normalization, deduplication, and stable
ordering run before a 101-row truncation probe; the result contains at most 100
entries and an explicit truncation flag. Entries contain only the supported
scope kind, private/group conversation variant when applicable, a fixed label,
and a purpose-bound 16-character fingerprint. Raw owner and scope identifiers
are absent, and schema-unresolvable tool scopes are omitted. B3 does not resolve
fingerprints, issue session handles, or register `/scopes`.

The B5C issuance projection reuses the same normalized rows and stable ordering.
It passes each exact raw scope only to a trusted issuer callback and explicitly
returns the existing fingerprint, scope kind, optional conversation type, fixed
label, 43-character opaque handle, and numeric absolute expiry. Issuer extras,
session evidence, and raw scope fields are not copied into the DTO.

B15A adds the separate
`GovernanceQueryService.listPrivacyPreferenceScopeHandles` projection. It reads
valid non-empty canonical users in `last_seen_at DESC, id ASC` order before a
101-row truncation probe, includes users with no existing preference or
maintenance proposal, and emits at most 100 entries. Each entry contains only
the existing logical-scope fingerprint, `scopeKind: user`, the fixed
`User privacy` label, a 43-character handle, and numeric expiry. The trusted
issuer alone receives `{ kind: 'user', canonicalUserId }`; its other return
fields are ignored. The fingerprint is stable display correlation for the
persistent selector and grants no authority. The handle remains bound to the
issuing session, exact user scope, expiry, and future
`governance.privacy.preferences.read` route purpose, and cannot resolve for
`memory.maintenance.review`. B15A registers no HTTP route.

B15B adds `GovernanceQueryService.listPrivacyPreferencesForScope`. A non-user
scope returns a fixed empty page without invoking the legacy read. An exact user
scope calls only `listPrivacyPreferences` with that canonical user and a 101-row
truncation probe, preserving scope-before-limit ordering and returning at most
100 entries plus explicit `truncated`. Its fixed entry contains preference type,
state, optional redacted reason, optional updater actor class and context, and
created/updated dates. The canonical owner and updater user identifiers are
absent. The existing CLI-oriented method and DTO remain unchanged. B15B
registers no HTTP route.

B16A adds the separate
`GovernanceQueryService.listMemoryRecordScopeHandles` projection. It reads
distinct global, user, group, exact private/group conversation, and system
scopes from `memory_records` without filtering lifecycle state. SQL validation,
normalization, deduplication, and the maintenance-catalog scope rank with
private conversations before group conversations run before the 101-row
truncation probe. Blank, whitespace-padded, non-text, over-256-character, and
structurally incomplete legacy identifiers are omitted. Tool records are not
widened into a selectable scope. Each entry contains the existing logical-scope
fingerprint and fixed label, scope kind, optional conversation type, opaque
handle, and expiry. The trusted issuer alone receives the exact scope for the
future `governance.memory.records.read` purpose; issuer extras and all raw scope
or session values are absent. B16A registers no HTTP route and does not change
the B12C memory-list projection.

B16C adds the separate `GovernanceQueryService.listMemoryRecordsForScope`
projection. Tool scope returns a fixed empty page because the schema cannot bind
a record to one exact tool name. Global and system scope require null owner
columns; user and group scope require their exact owner; private conversation
scope requires the exact conversation and null group; group conversation scope
requires the exact conversation and group. That predicate is applied before a
101-row probe across every lifecycle state. The result contains at most 100
entries in importance, update-time, creation-time, and internal-ID order with
explicit truncation.

Each entry contains only a purpose-bound 16-character `recordRef`, scope kind,
visibility, sensitivity, authority, kind, lifecycle state, confidence,
importance, aggregate source/revision counts, and dates. The full title and
content are redacted before Unicode-code-point bounds of 160 and 512 respectively;
the content field is named `contentPreview`, and both fields carry explicit
redaction and truncation signals. `secret` and `prohibited` titles/content use
the fixed `[REDACTED:restricted_memory]` marker and `textHidden: true`, while
their non-content metadata remains discoverable. Raw record, canonical-user,
group, conversation, subject, source, and evaluator identifiers, source context,
selectors, filters, caller limits, and unrestricted content are absent. The
legacy B12C list/DTO remains unchanged, and B16C registers no HTTP route or
mutation.

B17A adds the separate
`GovernanceQueryService.getMemoryRecordDetailForScope({ scope, memoryId })`
projection. The internal memory ID is trusted future resource-registry input,
not a browser selector. Tool scope and missing, malformed-owner, cross-scope,
or private/group-conversation-collision records return `null`; the complete
B16C exact-scope predicate and record match run before any provenance query.
After that match, independent 33-row probes return at most 32 sources, 32
revisions, and 32 matching memory audit entries in stable source-time/ID,
revision-number/ID, and newest audit-time/ID order with explicit truncation.
The record field is the unchanged B16C projection with exact aggregate source
and revision counts.

Source entries expose only a purpose-bound source reference, fixed source type,
resolution state and extractor classification, and timestamp. Revision entries
expose only a purpose-bound revision reference, number, fixed change and actor
classifications, optional valid lifecycle states parsed from hidden snapshots,
bounded redacted reason and signals, evaluator-link boolean, and timestamp.
Audit entries expose only a purpose-bound audit reference, bounded redacted
event type and summary, fixed level and risk classifications, evaluator-link
boolean, timestamp, and `detailsHidden: true`. Secret and prohibited records
use the fixed `[REDACTED:restricted_memory]` marker for record text, revision
reasons, and audit summaries. Raw record, owner, subject, source, revision,
audit, evaluator, and link identifiers, source context, structured snapshots,
audit details, caller controls, and unrestricted text are absent. B17A does not
call or change B12B `showMemory`, issue a scope or resource handle, register an
HTTP route, or add a mutation.

B17B adds
`GovernanceQueryService.listMemoryRecordResourceHandlePage(scope, issueHandle)`.
It shares B16C's exact-scope SQL, every-lifecycle-state 101-row probe, stable
ordering, record projector, counts, redaction, and explicit truncation. Tool or
empty scope results call no issuer. For each of at most 100 selected rows, only
the normalized exact scope and internal memory ID reach the trusted issuer; the
response adds only its 43-character opaque `handle` and numeric
`handleExpiresAt` to the unchanged B16C entry. Issuer extras, internal IDs, raw
scope/session values, and unrestricted fields are not copied. The future
binding uses the existing `governance.memory.records.read` purpose and distinct
`memory_record` resource kind. B17B does not wire that issuer into the
application, change the B16D route response, modify a registry, register a
detail route, or add a mutation.

B18A adds
`GovernanceQueryService.listExplainConversationScopeHandles(issueHandle)`. Its
authority is `context_traces`, not bare `agent_turns`: only a trace whose exact
conversation ID matches its FK-linked turn is eligible, and turns without a
stored trace are absent. Private traces require null group ID; group traces
require a valid group ID. Conversation and group identifiers must be text,
1-256 characters, clean under the complete supported edge-trim set, and free
of NUL, C0, and DEL controls. Invalid or structurally inconsistent legacy rows
are omitted.

Valid tuples are normalized and deduplicated before a 101-row probe, ordered by
latest stored-trace time and then the deterministic private/group conversation
tuple, and limited to 100 entries with explicit `truncated`. The trusted issuer
receives only the exact private or group conversation scope for the future
`governance.explain.turns.read` purpose. The fixed response contains only a
domain-separated 16-character fingerprint, `scopeKind: conversation`,
conversation type, fixed label, opaque handle, and numeric expiry; issuer
extras and all raw conversation, group, session, platform, and secret values
are absent. B18A does not call ContextBuilder, rebuild stored context, change
B13A-B13C or CLI behavior, implement a registry, or register an HTTP route.

B18C adds `GovernanceQueryService.listExplainTurnsForScope(scope)`. It accepts
only a structurally valid exact private/group conversation scope and selects an
`agent_turn` only when an FK-linked stored trace matches the turn conversation,
conversation type, null private group boundary, or exact group boundary.
Multiple stored traces do not duplicate a turn. The query orders by
`started_at DESC, id DESC`, probes 101 distinct turns, and returns at most 100
entries with explicit `truncated`. Each fixed entry contains only an
`explain-turn` fingerprint, `label: Turn`, `traceSource: stored`, known turn
status, start date, and optional valid completion date. Malformed scopes return
an empty page. Raw turn/context/conversation/group/sender/memory/message/action/
tool identifiers, Provider/model/response/token fields, unrestricted text, and
issuer extras are absent. B18C does not invoke B13A-B13C, ContextBuilder, a
registry, a handle issuer, or HTTP routing.

B19A adds
`GovernanceQueryService.listExplainTurnResourceHandlePage(scope, issueHandle)`.
B18C and B19A use one private selector for the exact-scope validation,
structural stored-trace predicate, finite status/date checks, 101-row probe, and
stable start/ID order. B19A offers only each selected internal turn ID and the
normalized exact conversation scope to the trusted issuer, then adds only
`handle` and `handleExpiresAt` to the B18C projection. The future binding uses
the existing `governance.explain.turns.read` purpose and distinct
`explain_turn` resource kind. Issuer extras and all raw turn, scope, session,
platform, and secret values remain absent. B19A does not wire the issuer into
the application, change B18D, modify a registry, register a detail route, or
add rebuild or mutation behavior.

B19B wires that issuer only into the existing exact-scope `/explain/turns`
handler. It uses the callback session digest and absolute expiry, the existing
Explain-read purpose, resource kind `explain_turn`, the selected internal turn
ID, and B19A-normalized scope. Matching five-part registry resolution succeeds;
cross-session, cross-purpose, cross-kind, and cross-scope resolution fails. The
route returns B19A unchanged and still performs no detail resolution.

B19C adds
`GovernanceQueryService.getExplainTurnDetailForScope({ scope, turnId })`. It
accepts only a clean 1-256-code-point internal turn ID and normalized exact
private/group conversation scope. One base query first requires the turn's
`context_pack_id` trace to match that turn and complete scope tuple, then selects
the newest stored trace matching the same tuple. Missing, malformed,
cross-scope, trace-less, and mismatched turns return `null` before any label,
action, execution, or tool read.

The fixed detail reuses the B18C turn summary. Context exposes only five array
counts, validated non-negative token-budget numbers, and at most 32 redacted
96-code-point filter and injected-identity labels, each with redaction and
truncation signals. Decision evidence prefers the turn-linked decision over a
newer unlinked row and exposes only finite decision metadata, array counts, at
most 32 known-or-`other` action types, and at most 32 ascending fixed execution
summaries. Executions reveal only fixed reaction-effect classifications,
presence booleans, normalized action types, bounded error codes, and dates.
Tools expose at most 32 ascending bounded names/error codes plus fixed status,
timing, and redaction fields. Every collection uses a 33rd-row truncation probe;
malformed JSON degrades to empty counts/lists or an omitted token budget.

Raw turn, trace, context, conversation, group, memory, message, action,
execution, and tool identifiers; context/action/tool payloads; free-form
reasons, suppressors, downgrade/error messages; Provider/model/response/token-
usage values; session/issuer data; and unrestricted text are absent. B19C does
not call B13A-B13C, ContextBuilder, a registry, or an issuer, and it adds no
route, rebuild, or mutation behavior.

B19D registers read-only
`/explain/turns/:resourceHandle` with the existing Explain-read purpose and
resource kind `explain_turn`. The shared boundary authenticates, rejects query
strings, and resolves exact current-session scope and resource authority before
the handler calls only `getExplainTurnDetailForScope({ scope, turnId })` with
the registry-owned internal ID. A matching detail is returned unchanged; a
resolved missing detail maps to fixed `404`. Invalid authority never reaches
B19C. ContextBuilder rebuild and all Explain mutations remain absent.

B12A moves the existing audit-inspection query, fixed DTO, and deterministic
display/structured redaction into `GovernanceQueryService`. Category, level,
event-type, event-ID, actor-user, risk, inclusive time, details, ordering, and
limit behavior remain unchanged, and `GovernanceCLI.listAudit` delegates without
reshaping the result. B12B moves the existing memory lookup, ordered source and
revision queries, recursively redacted state snapshots, and linked bounded audit
read into the same service; `GovernanceCLI.showMemory` delegates without
reshaping the result. B12C moves the existing database-backed memory-record list
query and repository hydration into the same service. Its default active state,
conditional source join, filters, importance/creation ordering, default 100-row
bound, missing-row omission, and exact `MemoryRecord` values remain unchanged;
only the CLI database branch delegates, while the repository-only fallback is
unchanged. B12D moves the visible memory-export filter, deterministic record
redaction, fixed field selection, and ISO date projection into the same service.
Only its database branch delegates; the repository-only branch reuses the same
pure projector and retains its existing retrieval behavior. B12E moves the
existing model-invocation aggregate query, finite purpose/status grouping,
known/unknown completed-usage counts, and shared Provider-latency projection
into the same service; `GovernanceCLI.summarizeModelInvocations` delegates
without reshaping. B12F moves the existing bounded tool-call inspection query,
fixed DTO, opt-in payload parsing, and deterministic redaction into the same
service. `GovernanceCLI.listToolCalls` delegates without reshaping, while the
context-explanation path keeps its ascending query and reuses the same pure row
projector without payloads. B12G moves the existing bounded action-decision
inspection query, fixed DTO, optional action projection, and deterministic
redaction into the same service. `GovernanceCLI.listActionDecisions` delegates
without reshaping, while the context-explanation path keeps its linked-decision
priority and reuses the pure row projector. B12H moves the existing bounded
action-execution query, fixed DTO, opt-in audit-entry projection, and
deterministic redaction into the same service.
`GovernanceCLI.listActionExecutions` delegates without reshaping, while the
context-explanation path keeps `WHERE action_decision_id = ?` and
`ORDER BY executed_at ASC, id ASC`, reuses the pure row projector without audit
entries, and retains CLI-owned effect labels. B12I moves the existing bounded
job query, fixed DTO, opt-in payload and result projection, malformed-JSON
fallback, and deterministic redaction into the same service.
`GovernanceCLI.listJobs` delegates without reshaping. B12J moves the existing
bounded job-attempt query, fixed DTO, opt-in result projection, malformed-JSON
fallback, and deterministic redaction into the same service.
`GovernanceCLI.listJobAttempts` delegates without reshaping. B12K moves the
existing bounded worker-heartbeat query, fixed DTO, opt-in details projection,
malformed-JSON fallback, and deterministic redaction into the same service.
`GovernanceCLI.listWorkerHeartbeats` delegates without reshaping. None of
B12A-B12K registers an HTTP route. B12L moves the existing bounded event-
processing-failure query, fixed DTO, opt-in details projection, malformed-JSON
fallback, and deterministic redaction into the same service.
`GovernanceCLI.listEventProcessingFailures` delegates without reshaping. B12L
also registers no HTTP route. B12M moves the existing bounded privacy-preference
repository read and fixed redacted projection into the same service.
`GovernanceCLI.listPrivacyPreferences` delegates without reshaping. B12M also
registers no HTTP route and does not move preference writes or enforcement.
B22A moves both existing local-admin CLI preference writes behind the typed
`GovernanceService.setPrivacyPreferenceAsLocalAdmin` operation. The shared
operation delegates once to the existing repository with the same actor,
reason, optional clock, transaction, redaction, audit, and enforcement
semantics; CLI grammar and output remain unchanged. B22A adds no expected-
snapshot behavior, preview, confirmation, HTTP route, or policy change.
B22B adds only an HTTP-disabled exact-user preference-change preview to
`GovernanceQueryService`. An absent row is the effective `opted_in` default;
stored rows contribute only validated presence and update-time version evidence.
The fixed identifier-free projection contains current and target state, the
preference-upsert/audit/immediate-enforcement effects, semantic rollback state,
and a domain-separated digest. Invalid users, types, states, stored evidence,
and effective no-ops return no preview. No authority, route, confirmation, or
write is added.
B25A moves the existing local-admin display-profile redaction behind typed
`GovernanceService.redactDisplayProfileAsLocalAdmin`. The shared operation keeps
the exact user/global-or-group selection, current-profile and nickname-history
updates, timestamps, transaction, zero-row audit, durable governance redaction,
per-table and total counts, and rollback-on-audit-failure behavior;
`GovernanceCLI.redactDisplayProfile` delegates once without changing its options,
success message, or errors. B25A adds no preview, expected snapshot, authority,
HTTP route, QQ command, or browser behavior.
B25B likewise moves the existing local-admin platform-account unlink behind
typed `GovernanceService.unlinkPlatformAccountAsLocalAdmin`. The shared
operation keeps the exact active-only lookup and guarded disable, ordinary
transaction, redacted audit without the raw platform-account identifier,
inactive no-op, and rollback-on-audit-failure behavior;
`GovernanceCLI.unlinkPlatformAccount` delegates once without changing its
options, success/not-active results, database error, or generic failure result.
B25B adds no identity discovery, relink/restore, preview, expected snapshot,
authority, HTTP route, QQ command, or browser behavior.

B26A adds only an HTTP-disabled display-profile exact-user catalog through
`GovernanceQueryService.listDisplayProfileScopeHandles`. It reads the union of
users represented by current profile or nickname-history evidence, validates
each exact identifier before deduplication, orders the distinct valid users, and
uses a fixed 101-row probe to return at most 100 entries. Each entry contains
only the stable user-scope fingerprint, fixed `user` kind and label, and a
purpose-specific opaque handle and expiry issued for future
`governance.display_profile.targets.read` authority. Raw canonical-user, group,
profile, history, session, and issuer-extra values remain absent. Canonical
users with no profile/history evidence are not discoverable. B26A adds no
profile-target page, preview, expected snapshot, mutation authority, route, or
browser behavior.

B26B adds only the HTTP-disabled exact-user target page
`GovernanceQueryService.listDisplayProfileTargetsForScope`. It accepts one
B26A-valid user scope, then unions that user's valid current-profile and
nickname-history targets. The empty target denotes private/global display data;
non-empty group targets use the same bounded, fully trimmed, control-free
identifier contract. Targets are deduplicated, ordered private/global first and
then by raw group ID, and selected through a fixed 101-row probe returning at
most 100. Malformed target or metadata evidence does not create a target.

Each target exposes only a domain-separated fingerprint, fixed target kind and
label, current-profile presence/trust/observation metadata, and bounded history
count/truncation/lifecycle/latest-observation metadata. History count uses its
own 101-row probe and caps at 100; lifecycle is only `absent`, `open`, `closed`,
or `mixed`. Raw canonical-user, group, profile/history row IDs, display values,
history end times, session values, secrets, and unrestricted fields remain
absent. B26B issues no handle and adds no authority, route, preview, expected
snapshot, mutation, or browser behavior.

B26C adds only the HTTP-disabled target resource-handle page
`GovernanceQueryService.listDisplayProfileTargetResourceHandlePage`. It reuses
the exact B26B selector and projector, so scope validation, target and metadata
filtering, ordering, both 100/101 probes, fields, dates, and truncation remain
unchanged. For each selected target, it gives the trusted issuer only the exact
normalized user scope and a separate full domain-separated SHA-256 target
resource ID. The internal target ID is distinct from the 16-character display
fingerprint and is omitted from the response.

Each returned entry is the unchanged B26B target projection plus only an opaque
resource handle and numeric handle expiry. Issuer extras, raw canonical-user or
group IDs, profile/history text or row IDs, history end times, session values,
secrets, and unrestricted fields remain absent. Future registry wiring uses
purpose `governance.display_profile.targets.read` and resource kind
`display_profile_target`; B26C itself changes no registry, route, preview,
expected snapshot, mutation, confirmation, or browser behavior.

B26D registers only authenticated-unscoped read-only
`GET /governance/api/v1/display-profile/scopes` with discovery purpose
`governance.display_profile.scopes`. The shared boundary rejects
unauthenticated access, queries, and scope headers before B26A or issuance. A
current session delegates only to B26A and binds each selected exact-user scope
to that session digest and expiry plus purpose
`governance.display_profile.targets.read`. The unchanged catalog remains
identifier-free, stable, and write-free. B26D adds no target-list or target-
resource route, resource resolution, preview, expected snapshot, mutation,
confirmation, query-service behavior, registry implementation, CLI/QQ, or
browser behavior.

B26E registers only scoped read-only
`GET /governance/api/v1/display-profile/targets` with purpose
`governance.display_profile.targets.read`. The shared exact-scope boundary
rejects unauthenticated access, queries, and missing, malformed, unknown, cross-
session, or cross-purpose handles before B26C or resource issuance. A current
session delegates only to B26C with the resolved exact-user scope. Its trusted
issuer binds each selected target to that session digest and expiry, the same
purpose, resource kind `display_profile_target`, B26C's full internal target ID,
and the exact normalized user scope. The B26C page is returned unchanged and
remains identifier-free, stable, and write-free. B26E adds no dynamic target or
detail route, resource resolution, preview, expected snapshot, mutation,
confirmation, query-service behavior, registry implementation, CLI/QQ, or
browser behavior.

B26F adds only the HTTP-disabled exact-target detail projection
`GovernanceQueryService.getDisplayProfileTargetDetailForScope({ scope,
targetId })`. It accepts a valid exact-user scope and B26C's full 64-character
lowercase target ID, reuses the bounded B26B selection and B26C target-ID domain,
and performs current-value and nickname-history reads only after that selected
scope/target pair matches. The fixed result contains the exact B26B target
projection, an optional current display value, and at most 32 valid history rows
from a deterministic 33-row probe ordered by observation time and internal-row
tie-breaker. Display values use the existing governance secret/platform
redaction and a 160-Unicode-code-point bound with explicit redaction and
truncation signals; history exposes only a domain-separated fingerprint and
valid observation times. Raw user, group, target, profile/history-row, session,
platform, secret, malformed, and unrestricted values remain absent. B26F adds
no route, resource resolution, authority issuance, preview, expected snapshot,
mutation, confirmation, CLI/QQ, or browser behavior.

B26G registers only read-only
`GET /governance/api/v1/display-profile/targets/:resourceHandle` with the B26E
purpose and `display_profile_target` resource kind. The shared boundary first
authenticates, rejects queries and malformed authority, resolves the exact
current-session user scope, and resolves the target against the same session,
purpose, kind, and scope. The handler then calls only B26F with that resolved
scope and the internal target ID. Valid detail is returned unchanged with
`200`; a resolved target that no longer has selected evidence returns the fixed
identifier-free `404`. B26G adds no issuer, selector, preview, expected
snapshot, mutation, confirmation, CLI/QQ, or browser behavior.

B26H adds only the HTTP-disabled exact-target redaction preview
`GovernanceQueryService.getDisplayProfileTargetRedactionPreviewForScope({
scope, targetId })`. It accepts the same exact-user scope and B26C target ID as
B26F, reuses B26B selection, and then streams every exact matching current-
profile and nickname-history row through deterministic typed/hex fields into a
domain-separated snapshot fingerprint. The fixed response returns the unchanged
B26B target, exact safe-integer profile/history/open-history counts, exact
affected-row totals, conditional profile/history/redaction-closure effects, the
audit append, privacy consequences, and an explicit irreversible rollback
boundary plus a separate domain-separated preview digest. Raw user, group,
target, profile/history-row, value, session, platform, secret, and unrestricted
fields remain absent, and row iteration is constant-memory. B26H adds no
internal target selector output, expected-snapshot mutation, authority, route,
registry, CLI/QQ, or browser behavior.

B26I adds only an HTTP-disabled atomic expected-snapshot overload to the B25A
shared `GovernanceService.redactDisplayProfileAsLocalAdmin` owner. The existing
service and CLI input, scalar result, deferred transaction, timestamps, SQL,
audit, and zero-row behavior remain unchanged. The overload accepts one clean
canonical user, an optional clean non-empty group, the exact B26C target ID, all
four B26H current-snapshot fields, the fixed
`governance_http_display_profile_redaction_confirmed` reason code, and an
optional safe clock. Shared trusted query-service helpers retain B26C's target-
ID derivation and B26H's constant-memory typed/hex row stream. After strict
validation, the service begins an immediate transaction and recomputes that
snapshot before writing. No matching rows return `not_found`; malformed,
target-mismatched, or drifted evidence returns `stale`. An exact snapshot
redacts only its matching current-profile and nickname-history rows, closes
only open history intervals, verifies both update counts, appends one redacted
fixed-reason audit, and returns only `redacted`, the profile/history/open-
history counts, and `redactedAt`. Count mismatch and audit failure roll back the
whole transaction. B26I adds no preview change, authority, confirmation, route,
registry, CLI/QQ grammar, browser behavior, schema, or dependency.

B26J registers only mutation-marked
`POST /governance/api/v1/display-profile/targets/:resourceHandle` with B26E's
purpose and `display_profile_target` kind. The shared boundary authenticates,
enforces exact Origin/CSRF, rejects queries and malformed JSON or authority, and
resolves the current-session exact-user scope and target before the handler.
The handler accepts only `{ "action": "redact" }`, calls only B26H with that
resolved scope and registry-owned target ID, and conceals a missing current
preview as `404`. A valid response is the unchanged B26H projection plus a fresh
opaque handle and expiry. The existing single-use registry binds it to the
current session, local-admin actor, `display_profile.redact` action, resource
kind and ID, exact scope, snapshot fingerprint, total affected rows, and preview
digest. B26J does not consume that authority or invoke B26I/B25A; confirmation,
redaction, CLI/QQ grammar, and browser behavior remain absent.

B26K adds only the HTTP-disabled trusted internal resolver
`GovernanceQueryService.resolveDisplayProfileTargetRedactionMutationForScope({
scope, targetId })`. It accepts the same exact-user scope and full lowercase
B26C target ID as B26H, reuses B26B's bounded selected rows, and matches only
through B26C's domain-separated target-ID derivation. A selected target returns
only its exact canonical user, unchanged target ID, and either `groupId: null`
for private/global evidence or the exact non-empty group ID for group evidence.
Malformed, cross-user, missing, malformed-evidence, and B26B-unselected targets
return no selector. This raw internal selection is never added to a public DTO
or HTTP response. B26K changes no B26A-J projection, snapshot, digest,
authority, route, registry, service, mutation, CLI/QQ, or browser behavior.

B26L registers only mutation-marked
`POST /governance/api/v1/display-profile/targets/:resourceHandle/confirm` with
B26E's purpose and `display_profile_target` kind. The shared boundary
authenticates, enforces exact Origin/CSRF, rejects queries and malformed JSON or
authority, and resolves the current-session exact-user scope and target before
the handler. The handler accepts only `{ "confirm": true, "previewHandle":
HANDLE }` and consumes matching B26J `display_profile.redact` authority once;
unknown authority returns the fixed `404`, while replay returns `409`. It then
recomputes B26H and requires the exact bound fingerprint, affected-row total,
and digest, resolves only B26K's trusted internal selectors, and invokes only
B26I with the fixed HTTP reason. Missing owner evidence returns `404`; drift,
selector loss, or owner stale evidence returns `409`. Success returns only the
unchanged identifier-free target, exact affected and closed-history counts, ISO
redaction time, B26H effects and privacy consequences, fixed redacted audit
evidence, and B26H's irreversible rollback boundary. B26L adds no SQL,
duplicated mutation, caller reason, CLI/QQ grammar, browser behavior, schema, or
dependency.

B27A adds only the HTTP-disabled exact active-account unlink preview
`GovernanceQueryService.getPlatformAccountUnlinkPreview({ platform,
platformAccountId })`. It accepts only platform `qq` plus one normalized 5-12
digit QQ account identifier, reads only that exact active mapping, and validates
the fixed account type, verification level, status, canonical owner, and valid
observation interval. Every stored mapping field and SQLite storage type is
bound through deterministic hex evidence into a domain-separated snapshot
fingerprint. The fixed response contains only a separate stable account
fingerprint, platform/type/verification/status, bounded observation dates, the
guarded disable and redacted-audit effects, immediate future identity-resolution
exclusion, retained-mapping privacy consequence, explicit unsupported relink/
restore boundary, and a separate domain-separated preview digest. Missing,
inactive, malformed, or invalid-time mappings return no preview. Raw platform-
account and canonical-user identifiers remain absent. B27A adds no authority,
handle, route, expected-snapshot mutation, service/CLI change, QQ grammar,
browser behavior, schema, or dependency.

B27B extracts B27A's exact active-mapping reader and snapshot calculation as a
trusted synchronous helper, then adds an HTTP-disabled expected-snapshot
overload to `GovernanceService.unlinkPlatformAccountAsLocalAdmin`. The expected
path accepts only exact `qq` plus a normalized 5-12 digit account identifier,
B27A's one-field snapshot, the fixed HTTP unlink reason, and an optional valid
clock. It validates the exact object before SQL, recomputes the full mapping
snapshot inside an immediate transaction, and returns `not_found` for no active
mapping or `stale` for malformed or drifted evidence without writing. An exact
match performs only the guarded active-to-disabled update and one fixed
reason-bound redacted audit, requires exactly one updated row, and returns only
the outcome and disable time. Count mismatch is `stale`; audit failure rolls
back. The legacy overload retains its ordinary transaction, permissive selector
lookup, result shape, timestamps, audit bytes, and CLI delegation. B27B changes
no B27A projection/digest, authority, route, registry, CLI/QQ grammar, browser
behavior, persistence format, schema, or dependency.

B27C registers only mutation-marked authenticated-unscoped
`POST /governance/api/v1/identity/platform-accounts/unlink`. The shared HTTP
boundary authenticates, enforces exact Origin/CSRF, bounded JSON, no query, and
no scope header before accepting exact `{ "action": "unlink", "platform":
"qq", "platformAccountId": ID }` with a normalized 5-12 digit identifier. The
handler calls only B27A. Missing, inactive, or malformed mappings return fixed
`404`; a match returns B27A unchanged plus an opaque session-owned resource
handle and a separate short-lived preview handle. The resource registry alone
retains the structured raw selector under fixed system scope, identity purpose,
and `platform_account` kind. The preview binding carries the same resource and
scope, `identity.platform_account.unlink`, snapshot fingerprint, fixed one-row
version, and B27A digest. Repeated previews reuse only the resource handle and
issue fresh action authority. B27C adds no resource resolution, authority
consumption, confirmation route, B27B/B25B invocation, durable write, registry
implementation, CLI/QQ grammar, browser behavior, schema, or dependency.

B27D registers only the separate mutation-marked authenticated-unscoped
`POST /governance/api/v1/identity/platform-accounts/unlink/confirm`. The shared
boundary requires exact Origin/CSRF, bounded JSON, no query or scope header, and
exact `{ "confirm": true, "resourceHandle": HANDLE, "previewHandle": HANDLE }`.
The handler first resolves B27C resource authority against the current session,
identity purpose, `platform_account` kind, and system scope, then strictly parses
its canonical private `qq` selector. Missing, cross-boundary, or unsafe resource
authority returns fixed `404` without consuming action authority. It next
consumes matching B27C preview authority once, recomputes B27A, and requires the
exact snapshot fingerprint, fixed revision `1`, and preview digest before
invoking only B27B with `PLATFORM_ACCOUNT_UNLINK_REASON_CODE`. Unknown preview
authority is concealed; replay, drift, inactive evidence, or B27B not-found/
stale races conflict. Success returns only the identifier-free account evidence
with disabled status, one affected mapping, disable time, B27A effects and
privacy consequences, fixed redacted audit evidence, and B27A's unsupported-
relink rollback boundary. B27D adds no registry implementation, query/service
owner, SQL, caller reason, CLI/QQ grammar, browser behavior, schema, migration,
or dependency.

Remaining read projections implemented inside `GovernanceCLI` must
likewise move to the typed shared query service before a corresponding HTTP
route is enabled. Both CLI and HTTP then call the same query method. The HTTP
layer must not instantiate or parse CLI commands. Privacy and identity
mutations must likewise be factored behind shared typed methods before UI
exposure.

Backup, integrity, retention, and application-release actions continue to use
the existing operations modules. A governance operations coordinator may call
those functions with reviewed configuration, but it must not duplicate file or
SQLite maintenance logic in an HTTP handler.

B23A extracts the existing read-only `ops:doctor` inspection into the typed
`runOperationsDoctor` owner in `src/operations/doctor.ts`; the CLI delegates to
that owner and preserves its local path-bearing output. No HTTP-safe projection,
Operations route, backup/restore action, retention mutation, or browser view is
introduced until a later coordinator slice removes internal paths and binds the
same evidence to the governance session boundary.

B23B adds only the HTTP-disabled `GovernanceOperationsCoordinator`. It calls
the B23A owner once and reconstructs a fixed status DTO with safe generation,
overall, open/read-only, integrity/FK/schema, aggregate-count, configuration-
presence, and retention evidence. Raw database paths, integrity diagnostics,
missing-table names, URLs, credentials, identifiers, row payloads, unrestricted
keys, and injected extra properties are absent. The DTO states backup capability
without creating a file and marks restore execution `stopped_service_only`.
No route, session authority, preview, confirmation, backup/restore execution,
retention mutation, audit, schema, dependency, or browser behavior is added.

B23C adds only the HTTP-disabled `createVerifiedBackup` coordinator method. A
trusted internal destination path is passed once to the existing SQLite backup
owner and never appears in the result. The fixed result contains completion or
attention status, verified or attention-required integrity, bounded byte-size
and page evidence, and restore availability with the existing
`stopped_service_only` boundary. Owner errors collapse to one diagnostic-free
attention shape; malformed numeric metadata is bounded, marks the result for
attention, and leaves restore unavailable. Private staging, `0600` publication,
integrity validation, cleanup, and no-clobber behavior stay in the existing
owner. No Operations route, session authority, restore execution, retention
mutation, audit, schema, dependency, or browser behavior is added.

B23D registers only the authenticated-unscoped read-only
`GET /governance/api/v1/operations` route with purpose
`governance.operations.status.read`. It rejects query strings and scope headers
before calling the shared coordinator, returns the B23B fixed status unchanged,
and never calls B23C backup creation. The aggregate `/overview` route remains a
separate health summary. No path selector, handle, restore execution,
retention/audit mutation, or browser behavior is added.

B23E adds only the HTTP-disabled `previewVerifiedBackup()` coordinator method.
Its fixed path-free projection contains the `create_verified_backup` action,
available state, contract version, database-no-write/private-artifact/integrity-
verification/no-overwrite effects, `stopped_service_only` restore boundary,
unavailable in-process rollback with a fixed artifact-removal-not-exposed
reason, and a domain-separated SHA-256 digest over those ordered semantics. It
accepts no input and performs no inspection, destination selection, authority
issuance, file creation, backup call, database access, or route registration.
A separate later slice must own a private server-side destination before
confirmation can invoke B23C.

B23F registers only authenticated-unscoped mutation
`POST /governance/api/v1/operations` with purpose
`governance.operations.backup.preview`. It accepts the exact
`{ action: 'create_verified_backup' }` body after the existing session,
same-origin, CSRF, JSON, query, and scope-header boundary, calls only B23E, and
returns its unchanged projection plus fresh current-session preview authority.
The authority is bound to the fixed system backup operation, available state,
contract version, and digest. No client path selector, destination disclosure,
authority consumption, confirmation route, B23C call, file creation, database
or audit write, restore, retention, schema, dependency, or browser behavior is
added.

B23G adds only the HTTP-disabled no-input
`createServerOwnedVerifiedBackup()` coordinator adapter. It resolves the real
database location, creates or validates one fixed hidden sibling directory as
an owned non-symlink `0700` directory, generates a random 256-bit opaque
reference, and passes the corresponding private destination once to B23C. A
completed result adds only that reference to B23C's path-free evidence; a
non-completed result exposes a null reference. Artifacts remain `0600`, existing
safe directories are reusable, and unsafe entries are neither followed nor
repaired. No path or diagnostic is returned, no retry/overwrite/listing occurs,
and B23F, confirmation, authority consumption, audit/SQLite writes, restore,
retention, configuration, dependencies, routes, and browser behavior remain
unchanged.

B23H registers only authenticated-unscoped mutation
`POST /governance/api/v1/operations/confirm` with purpose
`governance.operations.backup.confirm`. It accepts only
`{ confirm: true, previewHandle }` after the existing session, same-origin,
CSRF, JSON, query, and scope-header boundary. The route consumes the B23F handle
once against its fixed action/resource/system binding, recomputes B23E, and
requires exact state, contract-version, and digest equality before calling B23G
once with no input. Unknown authority returns `404`; consumed or stale authority
returns `409` before effects. A current confirmation returns B23G's unchanged
fixed result with HTTP `200`; attention evidence has a null reference and is not
retried. No path, filename, diagnostic, direct B23C call, SQLite/audit write,
restore, retention, artifact deletion, rollback route, dependency, or browser
behavior is added. B23D status and B23F preview remain unchanged.

B23I adds only the HTTP-disabled
`previewServerOwnedBackupRestore(backupRef)` coordinator method. It accepts one
exact 43-character base64url reference, re-resolves the fixed private directory,
and reads only the corresponding contained artifact. The existing directory
must remain a real owned `0700` directory; the artifact must remain a real,
owned, single-link `0600` regular file with stable identity and size across a
no-follow read. A shared buffer-only integrity owner verifies copied SQLite
bytes in memory, normalizing rollback/WAL header bytes only in the copy, so the
artifact and directory gain no WAL/SHM sidecars or other mutation. Existing
path-based backup/restore verification is unchanged.

Success returns a fixed path-free `prepare_restore_handoff` preview with
verified state/size, contract version, no in-process database/artifact/restore
effect, required service stop, `stopped_service_only` execution, and
`no_in_process_effect` rollback evidence. The digest binds the exact reference,
artifact bytes, and ordered semantics internally; neither the reference nor its
fingerprint is returned. Invalid, missing, unsafe, changed, empty, or corrupt
artifacts return no preview without a diagnostic. No catalog, route, authority,
handoff file, restore, deletion, retention, audit/SQLite write, dependency, or
browser behavior is added, and B23D-H remain unchanged.

B23J exposes B23I only through authenticated-unscoped mutation
`POST /governance/api/v1/operations/restore` with purpose
`governance.operations.restore.preview`. After the existing session,
same-origin, CSRF, JSON, query, and scope-header checks, the route accepts exactly
`{ action: "prepare_restore_handoff", backupRef }` with one 43-character
base64url reference and calls B23I once. A null preview returns fixed `404`.
Success binds the current session, local-admin actor, fixed action/resource kind,
reference as internal resource ID, system scope, current state, contract version,
and digest into one preview handle, then returns the unchanged path-free preview,
opaque handle, and bounded expiry with `201`. The reference is never reflected.

No authority is consumed and `/operations/restore/confirm` remains absent. The
route performs no handoff, restore, retention, artifact mutation/deletion, or
database/audit write; adds no catalog or resource lookup; and exposes no path,
filename, fingerprint, credential, or diagnostic. Existing Operations status,
backup preview/confirmation, private artifact creation, and B23I validation are
unchanged.

B23K registers only authenticated-unscoped mutation
`POST /governance/api/v1/operations/restore/confirm` with purpose
`governance.operations.restore.confirm`. It accepts exactly
`{ confirm: true, previewHandle, backupRef }` after the existing session,
same-origin, CSRF, JSON, query, and scope-header boundary. Both opaque values are
43-character base64url strings. The route consumes only current-session B23J
authority with the fixed local-admin/action/resource/reference/system binding;
unknown or mismatched authority returns `404`, while stale or reused authority
returns `409`.

The handler recomputes B23I once and requires exact state, contract-version, and
digest equality. A current confirmation invokes only the trusted B23N
route-to-publication wiring, which calls B23L with the configured database path,
exact internal reference, current preview digest, contract version `1`, and the
current governance clock. The route returns the fixed path-free B23L receipt with
`200`; no reference, digest, database path, handoff path, or diagnostic is
reflected. No database/audit or backup-artifact mutation, restore, retention,
service stop, restart, or supervisor integration occurs in-process.

B23L adds only an HTTP-disabled durable-envelope owner for a future
stopped-service integration. Trusted internal code supplies an absolute
normalized database location, one exact backup reference and preview digest,
restore contract version `1`, and a valid time; no client path, session handle,
credential, or restore command is accepted. The owner resolves only the fixed
sibling `.lethebot-governance-restore-handoff` directory, requiring a canonical,
current-user-owned, non-symlink `0700` directory, and publishes at most one fixed
owned, single-link `0600` `pending.json`.

The strict version-`1` pending envelope contains a fresh random 256-bit handoff
ID, the internal reference/digest/version binding, millisecond UTC creation time,
expiry exactly 15 minutes later, and `stopped_service_only`. Exclusive private
staging, file and directory fsync, and hard-link no-clobber publication preserve
the first envelope. Success exposes only pending state, ID, expiry, execution
boundary, and `restoreExecution: false`; every invalid, existing, unsafe, raced,
or local-error case returns the same path-free attention receipt with null
ID/expiry. The owner neither reads the database/backup nor repairs or removes
foreign state. It is not registered in B23K, HTTP, CLI, browser, supervisor, or
service lifecycle code and performs no restore, retention, SQLite, or audit
effect.

B23M adds only the HTTP-disabled read-only owner that reopens B23L after process
restart. From a trusted normalized database location and optional injected
time, it resolves the same fixed sibling directory and fixed `pending.json`.
The canonical owned non-symlink `0700` directory must contain exactly that one
owned, single-link, non-symlink `0600` file. A no-follow bounded read requires
stable directory/file identity and the exact canonical B23L schema, reference/
digest formats, contract version, 15-minute timestamp relation, execution
boundary, and live creation/expiry window.

Valid state returns only pending status, handoff ID, expiry, contract version,
execution boundary, and `restoreExecution: false`; reference, digest, path, and
diagnostic remain internal. Every missing, expired, malformed, changed,
oversized, unsafe, multi-link, extra-entry, or owner-error state returns the
same attention receipt with null ID/expiry/version. Reopen never writes,
repairs, consumes, extends, or deletes the envelope and remains absent from
HTTP, CLI, browser, supervisor, service lifecycle, SQLite/audit, retention, and
restore execution. B23N is the only route-to-publication wiring: it runs only
after B23K authority and B23I equality checks, calls no reader/database/artifact
owner, and returns an existing/raced/unsafe/local-error publication as the fixed
attention receipt without overwrite or retry. A successful pending envelope can
be reopened by B23M after a fresh process, while single-use authority prevents a
repeated confirmation from publishing again.

B23O adds only the independent HTTP-disabled stopped-service consumer. A future
service adapter must construct it with the trusted configured database and the
exact B23I resolver, then supply a typed current stopped proof; no browser or
HTTP input can provide a path, reference, digest, stop assertion, or restore
option. The owner reuses B23M's strict envelope validation, requires B23I
digest/version equality, the fixed private database-sibling backup, absent
target WAL/SHM sidecars, clean integrity and foreign keys, then claims before
delegating only to the existing atomic SQLite restore owner.

The private claim records exact envelope/artifact/target bindings and bounds
execution to the initial attempt plus one recovery attempt. A target already
equal to the verified backup completes recovery without another restore;
successful completion is durable and all later calls are no-op conflicts. Only
fixed path-free completed, recovered, or attention evidence is returned. Backup
bytes, unrelated files, and audit behavior remain unchanged. B23O adds no route,
session authority, CLI grammar, supervisor, service stop/restart, retention,
schema, dependency, deployment, browser, QQ, or Provider behavior.

Except for an explicitly authenticated-unscoped discovery projection, every
service method used by HTTP accepts a server-resolved actor and exact scope,
applies scope predicates before bounded limits, returns a fixed DTO, and records
the same revision/audit evidence as CLI or QQ. Discovery methods accept only the
trusted issuer needed to create selectable exact-scope handles. The browser
never receives a repository object, unrestricted JSON column, SQL error, stack,
filesystem path, credential, or raw chat row.

## Listener And Configuration

The implemented listener configuration is:

| Setting | Contract |
|---|---|
| `LETHEBOT_GOVERNANCE_ENABLED` | Literal boolean, default `false`. |
| `LETHEBOT_GOVERNANCE_HOST` | Exact `127.0.0.1` or `::1`, default `127.0.0.1`; every other value is invalid in P8. |
| `LETHEBOT_GOVERNANCE_PORT` | Integer `1..65535`, default `6701`; must not equal the application listener port when enabled. |
| `LETHEBOT_GOVERNANCE_ADMIN_TOKEN` | Required only when enabled; 32 to 512 UTF-8 bytes, no control characters; never logged, persisted, or returned. |
| `LETHEBOT_GOVERNANCE_SESSION_TTL_MS` | Integer `60000..3600000`, default `900000`; absolute, not sliding. |

A2 adds no dependency. `LetheBotApp` constructs the boundary with an empty
domain route table, starts it before the application listener, closes both
listeners if either startup fails, and closes both during normal shutdown.
Enabling the listener creates only in-memory session state. Disabling it opens
no governance port and changes no CLI, QQ, database, schema, tool, Provider, or
worker behavior.

## Session And CSRF Contract

The API prefix is `/governance/api/v1`. The session routes are:

| Method and path | Behavior |
|---|---|
| `POST /governance/api/v1/session` | Verify same-origin request and the configured admin token, rotate a session, and return a CSRF token. |
| `GET /governance/api/v1/session` | Return bounded session expiry and actor class for a valid session. |
| `DELETE /governance/api/v1/session` | Require session, same origin, and CSRF; invalidate the session and expire the cookie. |

Successful login creates independent random 256-bit session and CSRF values.
Only a SHA-256 digest of the session value is retained in memory. At most eight
sessions exist; expired sessions are removed before capacity checks. Process
restart invalidates every session.

The session cookie is `lethebot_governance_session` with `HttpOnly`,
`SameSite=Strict`, `Path=/governance`, the configured absolute `Max-Age`, and no
`Domain`. P8 serves loopback HTTP, so it does not claim the `Secure` attribute;
a later HTTPS boundary must add it. Session and CSRF values never enter URLs,
logs, audit details, metrics, HTML, local storage, or error text. The CSRF value
is held only in page memory and sent as `X-LetheBot-CSRF`.

C1 serves the first browser workflow at exact sessionless GET paths
`/governance`, `/governance/`, `/governance/app.css`, and
`/governance/app.js`. The two root paths are byte-identical semantic HTML; the
other paths are one same-origin stylesheet and ES module. They use the existing
static security headers, exact MIME type and byte length, and perform no
authentication, session, handle, query, database, or audit work. Queries,
unknown paths, and non-GET variants remain `404`.

The application starts at a labelled admin-token form, clears the input after
submission, and uses only the existing session API. Its CSRF value remains in
module memory and is used only for sign-out; reload returns to the login view.
After login it calls the existing aggregate Overview API and renders the fixed
attention, review, job, worker, action, tool, event, and audit numbers via DOM
text nodes. It has stable loading, healthy/attention/zero, unavailable,
session-expired, refresh, and logout states.

C2 adds Activity navigation and one read-only Model invocations view over the
existing B14A authenticated-unscoped endpoint. Selecting or refreshing it sends
only exact same-origin `GET /governance/api/v1/activity/model-invocations` with
no query, body, scope header, or CSRF value. The fixed DOM renders total, the
three known purpose buckets, four known status buckets, completed known/unknown
usage, Provider-latency count/sum/maximum, and generated time. Missing known
buckets render as zero; zero total, loading, malformed/unavailable, and session-
expired responses have separate bounded states. Response keys never become
labels or markup. Overview remains the post-login default and both navigation
controls update `aria-current` and focus the main region. The browser never
reads cookies or web storage, constructs HTML from response data, reflects
server diagnostics, or introduces filters, scoped reads, or mutations. Other
Activity pages remain absent in C2.

C3 adds semantic secondary Activity navigation and one read-only Tool calls
view over the existing B14D authenticated-unscoped endpoint. Model invocations
remains the default Activity subview. Selecting or refreshing Tool calls sends
only exact same-origin `GET /governance/api/v1/activity/tool-calls` with no
query, body, caller limit, scope header, CSRF value, or new authority. The
browser accepts only an array of at most 100 records with the exact known B14D
keys, fixed requester/actor/context/status classifications, bounded text and
timing, a boolean redaction signal, and valid ISO creation time. Unknown keys,
oversized lists, malformed fields, invalid dates, transport failures, and
non-`200` responses produce one fixed unavailable state; `401` returns to the
existing session-expired login state.

The semantic table renders fixed Tool, Actor and context, Outcome, Duration,
and Recorded columns. Tool name and fixed requester label, actor class and
context, fixed status, optional bounded redacted error code/message, persisted
redaction signal, execution time, and creation time use `textContent` and DOM
creation only. The response's call, turn, and canonical-user identifiers are
validated but never inserted into the DOM; input and output remain absent from
the B14D response. Zero records, loading, refresh, stale-request cancellation,
keyboard tab navigation, and mobile labelled-row reflow have explicit states.
Other Activity pages, filters, details, scoped reads, and mutations remain
absent.

C4 adds a third semantic Activity tab and one read-only Worker heartbeats view
over the existing B14B authenticated-unscoped endpoint. Model invocations
remains the default and Tool calls remains the second tab. Selecting or
refreshing Worker heartbeats sends only exact same-origin
`GET /governance/api/v1/activity/worker-heartbeats` with no query, body, caller
limit, scope header, CSRF value, or new authority. The browser accepts only an
array of at most 100 records containing bounded `workerId`, `workerType`, fixed
`idle`/`running`/`stopping`/`error` status, optional bounded `currentJobId`, and
a valid ISO `heartbeatAt`. Unknown keys, `details`, oversized lists, malformed
fields or dates, transport failures, and non-`200` responses produce one fixed
unavailable state; `401` returns to the existing session-expired login state.

The semantic table renders fixed Worker, Status, Current job, and Last heartbeat
columns. Already-redacted worker, type, and optional current-job strings, fixed
status labels, and heartbeat time use `textContent` and DOM creation only. Zero
records, loading, refresh, stale-request cancellation, keyboard tab navigation,
and mobile labelled-row reflow have explicit states. The browser adds no age
inference, filters, details, links, or mutations, and every other Activity page
remains absent.

C5B adds Jobs as the fourth semantic Activity tab after Worker heartbeats while
preserving Model invocations as the default. Selecting or refreshing Jobs sends
only exact same-origin `GET /governance/api/v1/activity/jobs` with no query,
body, caller limit, scope header, CSRF value, or new authority. The browser
accepts only an array of at most 100 exact B14C records. Required bounded `id`,
`type`, fixed `pending`/`running`/`completed`/`failed` status, safe-integer
`attempts`/`maxAttempts`, and valid ISO `createdAt`/`updatedAt`/`scheduledAt`
fields are checked alongside optional bounded `idempotencyKey`, `leaseOwner`,
and `error` strings and optional ISO lease, heartbeat, start, and completion
times. Unknown keys, payload, result, oversized arrays, and malformed fields
produce the fixed unavailable state before any row is replaced; `401` reuses
the existing session-expired login state.

The responsive semantic table renders fixed Job, State, Schedule and updates,
and Run lifecycle columns. It shows the already-redacted job/type/status,
attempt progress, schedule/update times, and applicable lease, heartbeat,
start, completion, and error evidence through DOM creation and `textContent`
only. Loading, zero-record, refresh, unavailable, stale-request cancellation,
keyboard tab navigation, and mobile labelled-row states are explicit. The view
adds no inference, filter, detail link, polling, mutation, payload/result access,
or backend authority; every other Activity page remains absent.

C5C changes no browser surface or request contract. It replaces the three
separate Tool calls, Worker heartbeats, and Jobs binding/loading/cancellation/
listener paths with one fixed list controller and three explicit configurations.
Each configuration retains its exact DOM elements, same-origin endpoint closure,
strict renderer, loading and result messages, and independent request sequence.
The helper preserves loading, stale-result cancellation, `401` session expiry,
unavailable, empty/content, refresh, selection, and keyboard behavior in the
same order. Overview and Model invocations remain bespoke; HTML, CSS, visible
text, tab order, validators, row renderers, and safe DOM construction are
unchanged. The fixed assets stay below both the C5C 61,500-byte regression and
the permanent 65,536-byte shell boundary without minification, another asset,
lazy loading, or a dependency.

C5E also changes no browser surface or request contract. It replaces repeated
fixed JavaScript mechanics with one explicit key/ID binding table, explicit
accepted-value domains and deterministic labels/classes, shared required and
optional bounded text/date checks, shared record cell/status construction, and
one bounded normalized-list renderer. Tool calls, Worker heartbeats, and Jobs
retain named renderers, separate exact-key validators, their accepted domains,
normalization outcomes, DOM text/classes/order, count labels, limits, endpoint
closures, controller states, and request sequences. HTML and CSS remain byte-
identical, JavaScript stays readable and dependency-free, and the combined
fixed assets stay below 57,500 bytes without token/whitespace minification, a
new asset, compression, or lazy loading.

C5D adds Job attempts as the fifth semantic Activity tab after Jobs while
preserving the first four positions and Model invocations as the default.
Selecting or refreshing it sends only exact same-origin
`GET /governance/api/v1/activity/job-attempts` with no query, body, caller
limit, scope header, CSRF value, or new authority. The browser accepts at most
100 exact B14G records with required bounded `id`, `jobId`, and `workerId`, a
positive safe-integer `attemptNumber`, fixed `running`/`completed`/`failed`
status, and canonical ISO `startedAt`; optional `completedAt` and `heartbeatAt`
must be canonical ISO dates and optional `error` must be bounded text. Unknown
keys, `result`, malformed fields, and oversized arrays produce the fixed
unavailable state before any row replacement. The separate attempt `id` is
validated but projected away; the table renders only job and attempt number,
worker, fixed status, optional redacted error, and the three times through DOM
creation and `textContent`.

The fifth view reuses the C5C controller, C5E binding/validation/cell/status/list
primitives, existing responsive table styles, and all loading, empty, refresh,
unavailable, stale-request, session-expiry, keyboard-tab, focus, and mobile-row
behavior. It adds no CSS, filter, detail link, polling, mutation, payload/result
access, backend authority, or dependency. C5E's less-than-57,500-byte result is
the predecessor acceptance threshold; C5D retains the structural primitives and
keeps its completed candidate below the 61,500-byte feature threshold and the
65,536-byte permanent boundary.

C6A adds Action decisions as the sixth semantic Activity tab after Job attempts
while preserving the first five positions and Model invocations as the default.
Selecting or refreshing it sends only exact same-origin
`GET /governance/api/v1/activity/action-decisions` with no query, body, caller
limit, scope header, CSRF value, or new authority. The browser accepts at most
100 exact B14E records with required non-empty `id` and `turnId` bounded to 256
UTF-16 code units, canonical ISO `createdAt`, fixed `attention`/`pi`/`evaluator`
`decidedBy`, fixed `low`/`medium`/`high`/`prohibited` `riskLevel`, finite
`confidence` in `0..1`, boolean `evaluatorRequired`, optional boolean
`evaluatorPassed`, and a non-negative safe-integer `actionCount`. Required
`reasons` and `suppressors` arrays may each contain at most 32 non-empty strings
bounded to 512 UTF-16 code units. Unknown keys, `actions`, missing or malformed
fields, unbounded nested values, and oversized arrays produce the fixed
unavailable state before any row replacement.

The validator projects away `turnId`; the semantic table renders only the
already-redacted decision reference and time, actor/risk, confidence/evaluator
state, action count, and bounded reasons/suppressors through DOM creation and
`textContent`. The sixth view reuses the fixed controller, C5E/C5D validation,
cell, list, loading, empty, refresh, unavailable, stale-request, session-expiry,
keyboard-tab, focus, and mobile-row primitives and adds no CSS, filter, detail
link, polling, inference, mutation, action payload access, backend authority,
dependency, external asset, or lazy request. C5D's less-than-61,500-byte result
remains its completed feature threshold; the six-view bundle remains below the
65,536-byte permanent boundary.

C6B is a behavior-preserving prerequisite for the next Activity view. The
Model invocations tab and panel remain static. One fixed local definition table
now constructs the other five tabs and panels before their existing controllers
query the DOM. Construction uses only fixed literals, `document.createElement`,
attributes, and `textContent`; it reproduces the exact element hierarchy, text,
attributes, order, classes, initial hidden and busy states, skeleton dimensions,
captions, columns, and native-versus-explicit table semantics. Controller
configuration is derived from the same fixed entries, while endpoints,
validators, renderers, loading/empty/error/content transitions, stale-request
cancellation, session expiry, keyboard/focus behavior, CSS, and desktop/mobile
layout remain unchanged. The served HTML, CSS, and JavaScript are 8,641,
14,794, and 37,000 bytes, totaling 60,435 bytes. This is below the C6B
less-than-60,500 prerequisite and leaves 5,101 bytes below the permanent
65,536-byte boundary without HTML parsing, `innerHTML`, dynamic code, a new
request or asset, lazy loading, compression, minification, or a dependency.

C6C adds Action executions as the seventh semantic Activity tab after Action
decisions while preserving the first six positions and Model invocations as the
default. Selecting or refreshing it sends only exact same-origin
`GET /governance/api/v1/activity/action-executions` with no query, body, caller
limit, scope header, CSRF value, or new authority. The browser accepts at most
100 exact B14F records. Required non-empty `id` and `actionDecisionId` values are
bounded to 256 UTF-16 code units; `actionType` is one of the 12 current action
types; `status` is `success`, `downgraded`, `failed`, or `rejected`; `auditLevel`
is `summary`, `redacted_full`, or `full`; and `executedAt` is canonical ISO.
Optional message, memory, and job effect references are bounded to 256 units,
optional `downgradedFrom` is in the same action domain, and optional downgrade
and error evidence is bounded to 512 units. Unknown keys, `auditEntry`, nested
or malformed values, and oversized arrays produce the fixed unavailable state
before any existing row is replaced.

The responsive semantic table renders only the already-redacted execution and
decision references, execution time, fixed action/status, optional effect
references, downgrade/error evidence, and audit level through the shared safe
DOM and `textContent` primitives. The four execution statuses reuse the existing
green, amber, and red status tokens. Loading, empty, refresh, unavailable,
stale-request, session-expiry, logout, seven-tab keyboard/focus, and mobile-row
behavior remain explicit. The view adds no filter, detail link, polling,
inference, mutation, audit-entry access, backend authority, external asset, or
dependency. The served HTML, CSS, and JavaScript are 8,641, 14,850, and 39,809
bytes, totaling 63,300 bytes and leaving 2,236 bytes below the permanent
65,536-byte boundary.

C7A adds Event processing failures as the eighth semantic Activity tab after
Action executions while preserving the first seven positions and Model
invocations as the default. Selecting or refreshing it sends only exact same-
origin `GET /governance/api/v1/activity/event-processing-failures` with no
query, body, caller limit, scope header, CSRF value, or new authority. The
browser accepts at most 100 exact B14H records. Required non-empty `id` and
`stage` values are bounded to 256 UTF-16 code units, `errorName` is bounded to
512 units, `occurredAt` is canonical ISO, and `errorMessageHash` is lowercase
64-hex. Optional `rawEventId` and `turnId` are bounded to 256 units, optional
`conversationType` is `private` or `group`, and optional message, sender, and
conversation hashes use the same lowercase 64-hex form. Unknown keys, `details`,
nested or malformed values, and oversized arrays produce the fixed unavailable
state before any existing row is replaced.

The responsive semantic table renders only the already-redacted failure
reference and time, optional raw-event/turn references, stage and conversation
type, error name, and fixed hash evidence through the shared safe DOM and
`textContent` primitives. Loading, empty, refresh, unavailable, stale-request,
session-expiry, logout, eight-tab keyboard/focus, and mobile-row behavior remain
explicit. The view adds no filter, detail link, polling, inference, mutation,
failure-details access, backend authority, CSS, external asset, or dependency.
The served HTML, CSS, and JavaScript are 8,641, 14,850, and 42,007 bytes,
totaling 65,498 bytes and leaving 38 bytes below the permanent 65,536-byte
boundary.

C7B adds no browser workflow. It consolidates the identical legacy
tool/worker/job limits into fixed shared 100-record, 256-unit text, and 512-unit
diagnostic constants, and replaces repeated primary, secondary, and diagnostic
record-line class literals with fixed shared constants. Every required/optional
field, bound, accepted value, normalized record, emitted class, cell, and row
remains exact.

After the existing indentation and blank-line compaction, JavaScript-only
compaction removes raw line terminators immediately after `(`, `{`, `[`, comma,
or semicolon and immediately before `)`, `}`, `]`, comma, or semicolon. Other
line terminators remain; there is no token rename, expression rewrite, parser,
dynamic code, transport compression, HTML/CSS compaction, or dependency. Served
HTML and CSS are byte-identical, and the script retains exact endpoints,
definitions, validation, rendering, DOM, text/classes/order, state messages,
session and stale-request behavior, eight-tab keyboard/focus behavior, and
responsive layout. The final HTML, CSS, and JavaScript are 8,641, 14,850, and
39,788 bytes, totaling 63,279 bytes and leaving 2,257 bytes below the permanent
65,536-byte boundary.

C7C adds Audit as the ninth semantic Activity tab after Event processing
failures while preserving the first eight positions and Model invocations as
the default. Selecting or refreshing it sends only exact same-origin
`GET /governance/api/v1/activity/audit` with no query, body, caller limit, scope
header, CSRF value, or new authority. The browser accepts at most 100 exact
B14I records. Required non-empty `id`, `category`, `level`, `eventType`,
`eventId`, and `summary` strings are bounded to 256 UTF-16 code units, except
summary at 512; `timestamp` is canonical ISO; `detailsRedacted` and `redacted`
are booleans; and `actor` has only optional non-empty `canonicalUserId`,
`actorClass`, and `context` strings bounded to 256 units. Optional `riskLevel`
and `evaluatorDecisionId` strings use the same bound. Unknown top-level or actor
keys, `details`, nested or malformed values, and oversized arrays produce the
fixed unavailable state before any existing row is replaced.

The responsive semantic table renders only the already-redacted audit reference
and time, event type/reference, category/level, optional actor fields, bounded
summary, optional risk/evaluator evidence, and explicit details-hidden/redacted
signals through the shared safe DOM and `textContent` primitives. Loading,
empty, refresh, unavailable, stale-request, session-expiry, logout, nine-tab
keyboard/focus, and mobile-row behavior remain explicit. The view adds no
filter, details access, detail link, polling, inference, mutation, backend
authority, CSS, external asset, or dependency. The served HTML, CSS, and
JavaScript are 8,641, 14,850, and 41,778 bytes, totaling 65,269 bytes and
leaving 267 bytes below the permanent 65,536-byte boundary.

C8A changes only the fixed JavaScript ownership boundary. `app.js` uses one
static same-origin import from `/governance/activity.js`. The Activity module
owns the shared fixed Activity path prefix, exact endpoint definitions, strict
payload schemas and normalizers, date/value formatting, safe row construction,
and Model/list renderers. The shell retains the in-memory session/CSRF state,
login/logout, same-origin request transport, Overview, navigation, list
controller sequences, stale cancellation, loading/error/empty/content states,
listeners, announcements, and focus behavior. No dynamic import, code
evaluation, external asset, build step, package, or dependency is introduced.

Served HTML and CSS remain byte-identical. Endpoint values, request headers,
accepted and rejected payloads, emitted DOM tags/attributes/text/classes/order,
visible states, tab order, session transitions, and responsive structures stay
exact. The HTML, CSS, shell JavaScript, and Activity module are 8,641, 14,850,
18,380, and 23,616 bytes. The fixed HTML/CSS/`app.js` shell is 41,871 bytes,
leaving 23,665 bytes below 65,536; all four assets total 65,487 bytes, leaving
49 bytes below the existing aggregate boundary. The module route is static and
creates no API authority, scope/resource/preview access, or domain effect.

C8B adds Memory between Overview and Activity and keeps Records as its canonical
default. A separate static same-origin `/governance/memory.js` module constructs
the unframed destination, exact-scope selector, fixed states, and responsive
record table. Entering Memory or refreshing sends only exact authenticated GET
`/governance/api/v1/memory/scopes`. The selector shows only each fixed label and
16-character fingerprint. No record request occurs until the operator explicitly
selects an option; then exact GET `/governance/api/v1/memory/records` carries
only the corresponding 43-character handle in `X-LetheBot-Scope`. A matching
fingerprint preserves selection across primary navigation and catalog refresh,
while a refreshed handle replaces the prior in-memory authority.

Both responses require exact `{ entries, truncated }` shapes with at most 100
entries, reject unknown keys and duplicate references/handles, and validate all
fixed domains, Unicode text bounds, safe counts/scores, canonical ISO dates,
booleans, fingerprints, opaque handles, and conversation-field consistency.
Restricted records must use the fixed hidden marker and matching signals. A
malformed or unavailable response leaves prior row nodes unchanged and exposes
only the fixed unavailable state. Rendering includes only title/content preview,
record reference, classifications, lifecycle, scores, source/revision counts,
dates, and explicit redaction/truncation/hidden signals. Scope and resource
handles never enter DOM text or attributes, storage, or logs. There is no
automatic first-scope selection, detail control, Review queue, preview,
confirmation, mutation, filter, search, polling, or caller limit.

The HTML/CSS/`app.js` shell is 8,641/16,415/20,939 bytes, or 45,995 total.
`activity.js` and `memory.js` are 23,616 and 16,720 bytes. Every asset remains
below 65,536 bytes; the permanent module-era rule is the stricter shell bound
plus the per-asset bound, not a sum of independently cached feature modules.

C8C adds a two-tab Memory subview with Records selected by default and Review
second. Selecting or refreshing Review fetches only exact authenticated GET
`/governance/api/v1/scopes`; it carries no query, body, CSRF value, or scope
header. The operator must explicitly choose one Review scope before exact GET
`/governance/api/v1/memory-reviews` sends its 43-character handle in
`X-LetheBot-Scope`. Records and Review retain separate catalog arrays,
fingerprints, handles, and request sequences. Re-entering Memory selects
Records, while a still-present Review fingerprint can retain selection on a
later Review refresh with newly issued authority.

Review catalogs reuse only the fixed scope shape, labels, fingerprint, and
conversation consistency rules. Review pages require exact bounded entries and
validate proposal reference, kind, effect, lifecycle, selected scope kind,
64-character candidate fingerprint, finite confidence, positive candidate and
revision counts, unique fixed reason codes, canonical dates, resource handle,
and handle expiry before replacing rows. Proposal references, classifications,
candidate/reason/revision evidence, dates, and handle expiry render through DOM
creation and `textContent`; both scope and resource handles stay internal. No
Review detail, approve, reject, expire, apply, rollback, preview, confirmation,
filter, search, polling, or caller limit is present.

Final HTML/CSS/`app.js`/`activity.js`/`memory.js` sizes are
8,641/16,918/24,328/23,616/31,215 bytes. The fixed shell is 49,887 bytes and
every asset remains below 65,536 bytes. C8C adds no backend route, authority,
build step, package, or dependency.

C8D adds one `View details` command per Review row. The command stores only its
local row index in the DOM, resolves that index against the current normalized
page in module memory, and issues exact authenticated GET
`/governance/api/v1/memory-reviews/:resourceHandle`. The current selected Review
scope handle is the only `X-LetheBot-Scope` value. The request has no query,
body, `Origin`, CSRF value, raw selector, or Records-purpose authority. The
detail request sequence is independent from both Review catalog/list sequences.
Scope selection, returning to Records, primary navigation, Review refresh,
session expiry, and logout invalidate late responses and clear detail content.
A refreshed page retains selection only by the same proposal reference and
automatically reloads through that page's newly issued resource handle.

Detail responses require the exact list-level fields plus optional 16-character
effect-memory reference, fixed effect role, at most 32 exact candidate entries,
candidate truncation, at most 32 latest exact revision entries, and revision
truncation. Candidate ordinal/reference/role/state, record and source
fingerprints/count, and revision number/transition/state/actor/context/bounded
reason/canonical date are validated together with cardinality, order, role,
transition, and final-state consistency. Every list-level field, including
reason/date optionality, must equal the selected current row before rendering.
Unknown keys, malformed enums/references/fingerprints/dates/counts, duplicate
candidate references, inconsistent truncation, or row drift never replace the
last valid detail.

The unframed detail region has explicit unselected, loading, content, malformed,
unavailable, not-found, and changed states. It uses the existing semantic table,
state, button, and responsive classes to render bounded proposal/effect,
candidate record/source evidence, and revision transition/actor/reason/date
evidence through DOM construction and `textContent`. Scope/resource handles do
not enter text, attributes, storage, logs, or announcements. Approve, reject,
expire, apply, rollback, preview, confirmation, POST, filtering, search, and
polling remain absent. Final HTML/CSS/`app.js`/`activity.js`/`memory.js` sizes
are 8,641/16,918/24,227/23,616/50,900 bytes; the fixed shell is 49,786 bytes
and every asset remains below 65,536 bytes. No backend route, CSS, build step,
package, or dependency changes.

C8E adds one `View provenance` command per Records row. The command exposes only
its local row index in the DOM, resolves that index against the current
normalized page in module memory, and issues exact authenticated GET
`/governance/api/v1/memory/records/:resourceHandle`. The currently selected
Records scope handle is the sole `X-LetheBot-Scope` value. The request has no
query, body, `Origin`, CSRF value, raw selector, Review authority, or non-GET
method. Its request sequence is independent from the Records list and both
Review sequences. A Records refresh can retain selection only by record
reference and then reloads with the new row's resource handle. Scope changes,
entry into Review, primary navigation, expiry, and logout suppress late
responses and clear content and authority.

Detail responses require exact `{ record, sources, sourcesTruncated, revisions,
revisionsTruncated, audit, auditTruncated }` shape. The nested record is the
complete Records projection without list-only handle fields and must agree with
the selected current row, including optional expiry and every redaction signal.
Sources and revisions must equal the bounded prefix implied by their record
counts; each array and audit are capped at 32. Exact source classifications and
ascending time order, unique revision references/numbers and ascending revision
order, optional lifecycle/reason triplets, newest-first audit order, fixed
level/risk domains, evaluator booleans, canonical dates, and
`detailsHidden: true` are validated before replacement. Unknown keys, malformed
references/domains/dates/numbers, duplicates, excess arrays, inconsistent
truncation, restricted-text drift, or row/detail drift retain the last valid
nodes and expose only fixed malformed or changed states.

The unframed Record provenance region has explicit unselected, loading, content,
malformed, unavailable, not-found, changed, and cleared behavior. Existing
semantic table/button/responsive classes render only the fixed redacted record,
source, revision, and audit fields through DOM construction and `textContent`.
Scope and resource handles never enter text, attributes, storage, logs, or
announcements. Forget, restore, preview, confirmation, POST, filter, search, and
polling controls remain absent. HTML, CSS, `app.js`, and `activity.js` remain
byte-identical. Final HTML/CSS/`app.js`/`activity.js`/`memory.js` sizes are
8,641/16,918/24,227/23,616/64,978 bytes; the fixed shell remains 49,786 bytes
and every asset stays below 65,536. No backend route, CSS, build step, package,
or dependency changes.

C8F preserves that complete Records/Review experience while splitting only
static JavaScript ownership. `memory.js` imports one same-origin
`memory-presentation.js` module. Presentation owns the fixed schemas, value
domains, normalizers, row/detail coherence checks, safe DOM helpers,
formatters, and all Records/Review renderers. The controller retains endpoint
values, complete view construction, transport, exact-scope and row-resource
authority, independent selections and sequences, state/cancellation behavior,
listeners, navigation, focus, and `createMemoryFeature`. HTML, CSS, `app.js`,
and `activity.js` remain byte-identical. The final
HTML/CSS/`app.js`/`activity.js`/`memory.js`/`memory-presentation.js` sizes are
8,641/16,918/24,227/23,616/32,442/33,072 bytes; both Memory modules are below
35,000 and every asset is below 65,536. Runtime DOM structures, text, classes,
order, requests, accepted and rejected payloads, stale/session behavior, and
responsive output remain exact. No command, preview, confirmation, POST,
mutation, backend route, CSS token, build step, package, or dependency is added.

C8G adds `Preview approval` only inside coherent selected pending Review detail.
The controller resolves the current row from its local index, uses that row's
fresh resource handle and the selected Review scope handle, and supplies only
`{ "action": "approve" }` to a narrow shell-owned mutation transport. The shell
retains CSRF and sends exact same-origin
`POST /governance/api/v1/memory-reviews/:resourceHandle` with browser-derived
`Origin`, `X-LetheBot-CSRF`, `X-LetheBot-Scope`, and JSON content type. No raw
selector, displayed proposal reference, Records authority, query, or caller-
controlled action enters the request.

The response must be exact B7C `201`: canonical approval action; selected scope
kind/fingerprint; proposal kind/reference/effect; affected count/fingerprint;
`pending_review@N` current and `approved@(N+1)` expected state; the fixed three
durable effects and unavailable memory-record mutation; unsupported direct
rollback boundary; opaque preview handle; canonical digest; and safe future
expiry. Unknown keys, invalid values, duplicate or reordered effects, unsafe
counts/revisions, malformed authority, expired results, and any catalog/row/
detail/preview disagreement fail closed before rendering. The presentation
module reconstructs a sanitized value that omits the handle and digest.

The approval region exposes unrequested, loading, populated, malformed,
unavailable, not-found, and changed states. Duplicate in-flight commands are
disabled; an independent sequence suppresses late responses. Review selection,
scope, list/detail refresh, Records entry, primary navigation, expiry, session
change, and logout clear the preview. Rendering uses only bounded action,
proposal/effect and affected-record evidence, current/expected revisions, fixed
effects, rollback boundary, and expiry through DOM construction and
`textContent`. Preview handle/digest values never enter text, attributes,
storage, logs, or announcements. No confirmation command or request, handle
consumption, review transition, memory application, rollback, or durable write
is present. Final HTML/CSS/`app.js`/`activity.js`/`memory.js`/
`memory-presentation.js` sizes are 8,641/16,918/24,428/23,616/39,220/38,754
bytes; the fixed shell is 49,987 bytes and every asset stays below 65,536. C8G
adds no backend route, CSS, build step, package, or dependency.

C8H adds `Confirm approval` as an explicit second activation only after one
coherent, unexpired populated C8G preview. The presentation result remains the
same bounded handle-free preview. Separately, the controller retains one
private transient authority containing only the validated opaque preview
handle, its expiry, and a binding to the current selected proposal, list-issued
resource handle, Review scope handle/fingerprint/expiry, and current/expected
revision. The preview digest is still discarded. Neither this authority nor
the handle is returned from `createMemoryFeature`, passed back into
presentation values, or written to DOM text/attributes, storage, logs, or
announcements.

Activation first verifies that the current Review selection and detail still
match that binding and that the preview is unexpired. It then clears the stored
authority before the shell-owned transport sends exact same-origin
`POST /governance/api/v1/memory-reviews/:resourceHandle/confirm` using the
current list-issued Review resource handle, current Review
`X-LetheBot-Scope`, browser-derived `Origin`, in-memory `X-LetheBot-CSRF`, JSON
content type, and exact `{ "confirm": true, "previewHandle": HANDLE }`. No
query, displayed proposal reference, Records authority, `action`, reason, or
other caller-controlled field is sent. Both preview and confirm controls remain
disabled during confirmation, and clearing before the request makes repeated
activation locally single-use.

The exact `200` response must contain only canonical approval action and
approved outcome, the preview-bound proposal reference, `approved` at the
preview's next revision, approve transition with 16-hex revision and audit
references, `memoryRecordMutation: false`, and the unchanged
`approval_does_not_apply_memory_effects` rollback boundary. Unknown keys,
invalid values/references/revisions, and proposal or revision drift are
malformed before any result node is populated. The controller exposes separate
confirming, succeeded, malformed, unavailable, not-found, and conflict states.
Every failure leaves confirmation disabled and requires a fresh preview.

Success clears row, detail, preview, timer, and confirmation authority, then
uses the existing Review refresh control while preserving the bounded approved
result outside the cleared detail content. Scope/resource/selection changes,
manual list/detail refresh, Records entry, primary navigation, expiry, session
change, and logout cancel the independent confirmation sequence and clear its
authority; late responses cannot render. Final HTML/CSS/`app.js`/`activity.js`/
`memory.js`/`memory-presentation.js` sizes are
8,641/16,918/24,428/23,616/46,670/41,758 bytes. The fixed shell remains 49,987
bytes and every asset remains below 65,536. C8H adds no rejection, expiration,
application, rollback, memory-record mutation, backend route/DTO, CSS, build
step, package, or dependency.

C8I adds `Preview rejection` only inside coherent selected pending Review
detail. It uses the current local row index, fresh list-issued Review resource
handle, selected Review scope handle, and the shell-owned mutation transport to
send exact same-origin
`POST /governance/api/v1/memory-reviews/:resourceHandle` with browser-derived
`Origin`, in-memory `X-LetheBot-CSRF`, current Review `X-LetheBot-Scope`, JSON
content type, and only `{ "action": "reject" }`. It sends no query, displayed
proposal reference, Records authority, reason, handle, digest, confirmation,
or caller-selected extra field.

The exact B8A `201` response must contain canonical rejection action; current
scope kind/fingerprint; proposal kind/reference/effect; affected count and
fingerprint; `pending_review@N` current and `rejected@(N+1)` expected state; the
fixed proposal-transition, proposal-revision, and audit effects; unavailable
memory-record mutation; the rejection-specific unsupported rollback boundary;
an opaque preview handle; a canonical digest; and safe future expiry. Unknown
top-level or nested keys, invalid domains, duplicate or reordered effects,
unsafe counts/revisions, malformed authority, expired results, and any scope,
row, detail, or response disagreement fail closed before rendering.

The rejection region exposes unrequested, loading, populated, malformed,
unavailable, not-found, and changed states. Its request sequence and expiry
timer are independent from approval. Both preview commands are disabled while
either request is in flight, so duplicate activation is suppressed; sequence
changes suppress late results. Starting rejection preview clears the approval
preview and any private approval-confirmation authority before transport while
preserving current detail. Review resource/selection or scope changes, list or
detail refresh, Records entry, primary navigation, expiry, session change, and
logout clear rejection state and any competing approval authority. A subsequent
fresh coherent approval preview can create new approval authority.

Presentation reconstructs only bounded action, proposal/effect and affected-
record evidence, current/expected revisions, fixed effects, rejection rollback
boundary, and expiry through safe DOM construction and `textContent`. It
validates then drops both rejection handle and digest; neither reaches
controller authority, presentation output, DOM text/attributes, storage, logs,
or announcements. C8I adds no rejection-confirm control or `/confirm` request,
review transition, memory application, rollback, or durable write. Final HTML/
CSS/`app.js`/`activity.js`/`memory.js`/`memory-presentation.js` sizes are
8,641/16,918/24,428/23,616/53,035/46,484 bytes. The fixed shell remains 49,987
bytes and every asset remains below 65,536. No backend route/DTO, CSS, build
step, package, or dependency changes.

C8J adds `Confirm rejection` as the explicit second activation only after one
coherent, unexpired populated C8I preview. The controller retains a private
transient rejection authority containing only the validated opaque preview
handle, expiry, and binding to the current selected proposal, list-issued Review
resource handle, Review scope handle/fingerprint/expiry, and current/expected
revision. It continues to discard the preview digest. Neither this authority nor
its handle is returned from `createMemoryFeature`, passed to presentation values,
or written to DOM text/attributes, storage, logs, or announcements.

Activation verifies the current Review selection/detail binding and expiry, then
clears the authority before the shell-owned transport sends exact same-origin
`POST /governance/api/v1/memory-reviews/:resourceHandle/confirm`, using the
current list-issued Review resource handle, current Review `X-LetheBot-Scope`,
browser-derived `Origin`, in-memory `X-LetheBot-CSRF`, JSON content type, and
exact `{ "confirm": true, "previewHandle": HANDLE, "action": "reject" }` body.
It sends no query, displayed proposal reference, Records authority, approval
authority, reason, digest, or caller-controlled extra field. Preview and
confirmation controls remain disabled during confirmation.

The exact B8B `200` response must contain only canonical rejection action and
rejected outcome, the preview-bound proposal reference, `rejected` at the
preview's expected revision, a reject transition with bounded revision/audit
references, `memoryRecordMutation: false`, and
`rejection_does_not_apply_memory_effects`. Unknown keys, invalid values/
references/revisions, and row/detail/preview/result drift are malformed before
rendering. The controller exposes independent confirming, succeeded, malformed,
unavailable, not-found, and conflict states. Every failure consumes local
authority and requires a fresh rejection preview.

Success clears Review row, detail, rejection preview, expiry timer, and
confirmation authority, preserves only bounded rejected-result evidence outside
cleared detail content, and refreshes Review. Scope/resource/selection changes,
list/detail refresh, Records entry, primary navigation, expiry, session change,
logout, and a competing approval preview clear the authority and suppress late
responses. C8J adds no memory application, rollback, expiration, backend route/
DTO, direct repository or service path, CSS, package, dependency, polling, or
build step.

C9B completes the separate `Application preview` and `Confirm application`
workflow for coherent `approved` Review detail. Consolidation and decay preview
with exact `{ "action": "apply" }`; conflict shows a labelled retained-candidate
selector populated solely from current validated detail `memoryRef` values, makes
no default choice, and adds only `"retainedMemoryRef": REF`. Changing that
selection clears the prior projection, private authority, expiry timer, and any
confirmation state. Displayed proposal references, raw database IDs, query
parameters, preview digests, and extra fields are never request authority.

The exact B9A `201` response must match current Review scope fingerprint/kind,
proposal kind/reference/effect, approved revision, candidate count/fingerprint,
and the conflict selection when present. It must also contain exact ordered
retained/superseded or disabled role summaries, the next applied revision, fixed
durable-effect list, kind-specific retrieval consequence, supported rollback
with `separate_confirmation_required`, a bounded opaque preview handle/expiry,
and a digest that is validated then discarded. Unknown keys and any cross-stage
drift are malformed or stale before rendering. The rendered preview contains
only action/effect, bounded role counts, transition/revision, retrieval
consequence, and rollback boundary.

A populated preview enables an independent action-bound application authority.
Consolidation and decay confirm with exact `{ "confirm": true,
"previewHandle": HANDLE, "action": "apply" }`; conflict repeats only the current
validated `retainedMemoryRef`. Before dispatch, the controller revalidates the
selected review/detail, exact scope/resource, `approved` lifecycle, next revision,
expiry, and conflict selection, then clears the authority and expiry timer before
one request. Application authority is not shared with approval or rejection, and
all three workflows disable competing controls while one is loading or
confirming. Double activation, replay, expiry, scope/resource/detail/selection
change, refresh, Records entry, navigation, session change, logout, and late
responses cannot reuse it.

Confirmation has `confirming`, `succeeded`, `malformed`, `unavailable`,
`not-found`, and `conflict` states. The exact B9B result is accepted only when its
proposal/effect, ordered role counts and fingerprints, selection, applied
revision, retrieval consequence, redacted revision/audit references, and
`separate_confirmation_required` rollback boundary match the preview. Unknown
keys or drift are malformed. Failure requires a fresh preview; success preserves
only bounded result evidence, clears Review detail and transient authority, and
refreshes Review. The preview handle and digest never enter presentation values,
DOM or attributes, web storage, logs, announcements, or exported feature state.
C9B invokes only the existing governed B9B HTTP route and does not expose direct
rollback; B10 rollback and B11 expiration remain separate browser slices.

The browser sources now live as fixed same-origin HTML/CSS/JavaScript sidecars.
The TypeScript registry reads only its filename allowlist once at module startup,
serves the same in-memory routes with existing CSP and `no-store` headers, and
registers `/governance/memory-application.js`. The build copies these files into
`dist/http/governance-browser-assets/`; request paths never select filesystem
paths and requests perform no filesystem I/O. Every served asset remains below
65,536 UTF-8 bytes and no external runtime dependency was added.

Every non-`GET` request, including login, requires an exact same-origin `Origin`
for the active loopback listener. Every authenticated non-`GET` request also
requires the session-bound CSRF header. There is no CORS allowlist and no JSONP.
`GET` and `HEAD` routes are side-effect free. Authentication and CSRF checks run
before body parsing, scope resolution, governance service calls, or audit/domain
writes whenever the required evidence is absent.

The listener applies a 4,096-byte request-body limit and a 5-second receive
deadline. State-changing requests require `application/json`. Credential,
session, CSRF, cookie, origin, and parser failures use fixed diagnostic-free
responses.

Non-session dispatch has two disjoint route classes. Ordinary authorized routes
always require a valid scope handle. Authenticated-unscoped routes exist only
for discovery or explicitly system-wide projections that cannot already possess
a scope handle. They share the same authentication, mutation CSRF/body, query,
fixed-response, and callback-failure ordering, reject any scope header, and call
no scope resolver. Their handler receives only a server-owned local-admin actor,
the matched route, and a defensive session digest/absolute-expiry pair. Route
keys cannot collide across classes or with the session path. B5B registers no
production authenticated-unscoped route. B5C registers only read-only `/scopes`
in this class; it uses route purpose `memory.maintenance.review.scopes` and
issues handles for `memory.maintenance.review`. B6A also registers read-only
`/overview` with purpose `governance.overview.read`. B6B registers scoped,
read-only `/memory-reviews` with purpose `memory.maintenance.review`.
B15A does not widen `/scopes` or register a Privacy catalog or data route; it
only establishes the future privacy-purpose issuer projection.
B15B likewise registers no route. B15C separately registers read-only
`/privacy/scopes` with discovery purpose
`governance.privacy.preferences.scopes`; its trusted issuer binds handles only
to `governance.privacy.preferences.read`. The legacy `/scopes` response remains
proposal-backed and maintenance-only. B15D registers scoped read-only
`/privacy/preferences` with the privacy-read purpose and passes only the
resolved scope to B15B.
B24C separately registers read-only `/group-summary/scopes` with discovery
purpose `governance.group_summary_policy.scopes`; its trusted issuer binds
handles only to `governance.group_summary_policy.status.read`. B24D registers
scoped read-only `/group-summary/policy` with that status-read purpose and
passes only the resolved exact group scope to B24A. The summary-policy mutation
owner remains HTTP-disabled.
B26D separately registers read-only `/display-profile/scopes` with discovery
purpose `governance.display_profile.scopes`; its trusted issuer binds exact-user
handles only to `governance.display_profile.targets.read`. B26E registers scoped
read-only `/display-profile/targets` with that purpose. B26A remains the catalog
owner, while B26C remains the target resource-handle page owner and the HTTP
handler only binds its full target IDs to the current session, resource kind
`display_profile_target`, and resolved exact-user scope. B26G registers read-
only `/display-profile/targets/:resourceHandle` with that purpose and kind;
after the shared boundary resolves the current session, exact-user scope, and
target authority, the `GET` handler delegates only to B26F. B26J registers
mutation-marked `POST` at the same path, accepts only the redact action,
delegates only to B26H, and issues digest-bound current-session preview
authority. B26L registers mutation-marked `POST` at the same path plus
`/confirm`, consumes matching B26J authority once, and invokes only B26H -> B26K
-> B26I after exact fingerprint, affected-count, and digest revalidation.
B16A, B16C, B17A, and B17B register no route. B16B separately registers read-only
`/memory/scopes` with discovery purpose `governance.memory.records.scopes`; its
trusted issuer binds handles only to `governance.memory.records.read`. B16D
registers scoped read-only `/memory/records` with that read purpose. B17C passes
only the resolved scope to B17B and binds each selected record through the
current session digest/expiry, the same read purpose, resource kind
`memory_record`, internal record ID, and B17B-normalized exact scope. The
maintenance and Privacy catalogs and purposes remain disjoint. B17A issues no
handle. B17D registers read-only `/memory/records/:resourceHandle` with the same
Memory-read purpose and `memory_record` kind, then passes only the resolved
scope and internal record ID to B17A. B20B registers mutation-marked `POST` at
that same resource path. The shared boundary enforces exact Origin/CSRF and
accepts only `{ "action": "forget" }`; the handler calls only B20A and binds
its current state, revision, and digest into a fresh current-session,
action-specific preview handle. Confirmation and durable mutation remain
absent.
B18A does not itself register a route. B18B separately registers read-only
`/explain/scopes` with discovery purpose `governance.explain.turns.scopes`; its
trusted issuer binds handles only to `governance.explain.turns.read`. B18D
registers scoped read-only `/explain/turns` with that read purpose and passes
only the resolved exact conversation scope to B18C. B19A itself registers no
route. B19B changes only that handler to call B19A and binds every selected turn
through the current session digest/expiry, same purpose, `explain_turn` kind,
internal turn ID, and normalized exact scope. B19C is query-service-only. B19D
registers read-only `/explain/turns/:resourceHandle` with the same purpose and
`explain_turn` kind, then passes only the resolved scope and internal turn ID to
B19C. ContextBuilder rebuild and every Explain mutation route remain absent.
B6C registers the one-segment dynamic detail route with the same purpose and
resource kind `memory_maintenance_review`. Both list and detail receive the
server-owned session digest/absolute expiry; only the list may pass those values
to the trusted resource issuer. B7C registers `POST` at the same dynamic
resource path, purpose, and kind so the already-issued exact handles remain the
authority boundary. B8A accepts only the exact one-key bodies
`{ "action": "approve" }` and `{ "action": "reject" }`; the generic non-`GET`
ordering enforces same origin, session-bound CSRF, JSON/body bounds, and query
rejection before authorized dispatch. B9A additionally accepts exact
`{ "action": "apply" }` for approved consolidation and decay proposals, or
`{ "action": "apply", "retainedMemoryRef": REF }` for approved conflict
proposals. `REF` is structurally limited to the existing lowercase 16-character
hexadecimal display-reference format; the query projection verifies the exact
candidate and proposal kind before issuance.
B10A additionally accepts only exact `{ "action": "rollback" }` for an applied
conflict, consolidation, or decay proposal. It accepts no retained-memory
selection or other field and does not add a rollback confirmation form.
B11A additionally accepts only exact `{ "action": "expire" }` for a pending
conflict, consolidation, or decay proposal. It accepts no reason or other field
and does not add an expiration confirmation form by itself.
B7D registers the same purpose and resource kind at the exact static suffix
`/<resource-handle>/confirm`. The existing approval form remains exact body
`{ "confirm": true, "previewHandle": HANDLE }`; B8B adds only exact rejection
body `{ "confirm": true, "previewHandle": HANDLE, "action": "reject" }`.
B9B accepts exact
`{ "confirm": true, "previewHandle": HANDLE, "action": "apply" }` for
consolidation and decay, or the same body plus exact `retainedMemoryRef: REF` for
conflicts. B10B adds only exact
`{ "confirm": true, "previewHandle": HANDLE, "action": "rollback" }` with no
retained-memory selection. B11B adds only exact
`{ "confirm": true, "previewHandle": HANDLE, "action": "expire" }`. Unmatched
suffixes, other action values, invalid references, and extra fields or path
segments do not dispatch, and every existing mutation check remains before
scope/resource resolution or preview consumption.

All responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, a same-origin content security policy with no
external assets, and `frame-ancestors 'none'`. The login form permits password
manager entry but never repopulates or reflects the submitted token.

## Scope Contract

The server uses a discriminated exact scope internally:

```ts
type GovernanceScope =
  | { kind: 'global' }
  | { kind: 'user'; canonicalUserId: string }
  | { kind: 'group'; groupId: string }
  | {
      kind: 'conversation';
      conversationId: string;
      conversationType: 'private' | 'group';
      groupId?: string;
    }
  | { kind: 'tool'; toolName: string }
  | { kind: 'system' };
```

Clients do not construct this value from raw IDs. Purpose-specific discovery
routes return bounded redacted labels and opaque random handles for scopes the
current local-admin session may select. `GET /governance/api/v1/scopes` remains
the maintenance-review catalog; `GET /governance/api/v1/memory/scopes` returns
the record-backed Memory catalog; `GET /governance/api/v1/privacy/scopes`
returns the exact-user Privacy catalog;
`GET /governance/api/v1/group-summary/scopes` returns the exact-group summary-
policy catalog; and
`GET /governance/api/v1/explain/scopes` returns the stored-trace-backed exact-
conversation Explain catalog. A handle is bound to the issuing
session, exact scope, route purpose, and expiry. It cannot be used by another
session, as another scope kind, or for a broader route.

`GET /governance/api/v1/privacy/preferences` requires one handle from the
Privacy catalog and accepts no raw user selector. It returns only the fixed
bounded page for the resolved exact user scope. The separate
`POST /governance/api/v1/privacy/preferences/confirm` route requires that same
scope and exact confirmation body; it never accepts a raw user selector or
caller-provided reason.

`GET /governance/api/v1/group-summary/policy` requires one handle from the
group-summary catalog and accepts no raw group selector. It returns only the
fixed effective state, stored-evidence flag, nullable generation/eligibility,
and dates for the resolved exact group scope. Mutation-marked `POST` at that
path issues only a write-free target-state preview. Separate
`POST /governance/api/v1/group-summary/policy/confirm` requires the same exact
scope and an exact confirmation body; it accepts no raw group selector or
caller-provided reason.

Scoped API requests carry exactly one 43-character base64url handle in
`X-LetheBot-Scope`. Query-string scope selectors and raw scope fields are
rejected. The HTTP boundary resolves the handle against the authenticated
session and route purpose before calling an authorized handler.

List and detail routes require exactly one valid scope handle unless their
contract is explicitly system-wide aggregate health. Wildcards, empty handles,
raw platform IDs, multiple competing scope fields, mismatched conversation/group
tuples, and handles from another session fail before the application service.
Malformed scope syntax returns a fixed `400`; an unknown, expired,
cross-session, cross-purpose, missing, or unauthorized handle is indistinguishable
as a fixed `404`. Neither response confirms that a hidden scope or record exists.

The standalone scope-handle registry accepts only a trusted exact scope, a
SHA-256 session digest, a bounded route purpose, and the session's absolute
expiry. It issues a random 256-bit base64url handle and returns only that handle
and expiry. Reissuing the same live binding is stable; resolution returns a
defensive scope copy only for the exact session and purpose. Expiry, session
revocation, registry clear, and process restart invalidate handles. The registry
holds at most eight active session IDs and 512 bindings per session, removes
expired entries before capacity checks, and never extends session expiry. The
HTTP server now owns the registry through one resolve/revoke/clear interface.
Successful rotation, lazy expiry pruning, and logout revoke only the removed
session's bindings; listener close clears all bindings. `LetheBotApp` constructs
one registry with the server clock. B5C connects only the authenticated scope
catalog to that registry. B6B uses those handles for the maintenance-review list
and B6C detail. B7C, B8A, and B11A reuse them for the approval-, rejection-, and
expiration-preview POST, and B9A reuses them for the application preview. B7D
and B8B reuse the same exact resource handle for action-bound approval and
rejection confirmation; B11B does the same for expiration confirmation.

The standalone resource-handle registry applies the same eight-active-session,
512-bindings-per-session, absolute-expiry, cleanup-before-capacity, and fixed-
error constraints. It issues stable random 256-bit base64url values for one
exact live binding of session digest, route purpose, resource kind, exact scope,
and internal resource ID. Resolution requires all five dimensions and returns
only the resource kind plus internal ID to the trusted server callback. Session
rotation, lazy expiry, logout, listener close, process restart, cross-session,
cross-purpose, cross-kind, or cross-scope use invalidates or denies the binding.

The standalone B7A confirmation-preview registry issues a fresh random 256-bit
base64url handle for each trusted preview. Its absolute expiry is the earlier of
five minutes and the owning session expiry. Each handle binds the session
digest, server-owned local-admin actor, exact scope, action, resource kind and
internal ID, expected lifecycle state and revision, and a SHA-256 preview
digest. Consumption succeeds once only across the exact session, actor, scope,
action, resource kind, and resource ID boundary and returns the trusted resource, state,
revision, and digest binding. Expiry, session revocation, clear, or process
restart invalidates it. At most eight sessions and 64 live previews per session
are retained, with expired records removed before capacity checks. B7D retains
at most 64 recent consumed markers per session so an exact replay receives the
fixed conflict result without making the registry unbounded. B7B connects
the registry only to the existing central session removal and listener-close
boundaries. `LetheBotApp` constructs one registry with the shared server clock.
B7C, B8A, and B11A call only the trusted issue operation after the
action-specific query projection is available; the B7B lifecycle-only server
interface is unchanged. Repeated unchanged previews keep the same action-specific
payload digest but receive fresh handles. Approval, rejection, and expiration
use distinct action bindings and digests. B9A uses a third application action and digest; alternate conflict
retained selections produce distinct plans and digests. The response adds only
the handle and numeric expiry, returns `201`, and exposes no session digest,
CSRF, raw resource/scope identifier, or issuer input.
B10A uses a fourth rollback action and distinct digest bound to the applied
state/revision. Issuance remains preview-only and does not consume the handle.
B11A uses a fifth expiration action and distinct digest bound to the pending
state/revision. Issuance remains preview-only and does not consume the handle.
B7D, B8B, B9B, B10B, and B11B consume only the matching action-bound preview
through the exact confirmation route. An unknown, cross-boundary, or
cross-action preview returns fixed `404`; a matching consumed preview returns
fixed `409`. B20D and B21D reuse the same boundary for distinct Memory forget
and restore actions. B22E reuses it for `privacy.preference.change`, with the
preference type as resource ID and the target state bound by the digest.

The B2B normalized maintenance-review service accepts the same discriminated
scope shape internally, but supports only global, user, group, conversation,
and system scopes. Tool-name review remains unavailable until durable memory
ownership can distinguish one tool name without inference.

## Resource And Redaction Contract

Resource URLs and mutation inputs use opaque session-bound handles. Displayed
identifiers use purpose-bound fingerprints or the existing bounded display
formatters. Raw identifiers may be accepted only in an explicit local lookup
field, are never echoed, and are replaced by a redacted match fingerprint in the
result.

The B6C dynamic matcher accepts exactly one 43-character base64url resource
segment. The base path remains the list and is never interpreted as detail; a
malformed segment, extra path segment, query string, raw proposal ID, or caller-
supplied resource field never reaches resource resolution or the detail query.
After authentication, the exact scope handle resolves first;
the resource handle must then resolve for the same session, purpose, kind, and
scope. Unknown and cross-boundary resources are indistinguishable fixed `404`
responses.

Every response DTO has an explicit schema and maximum collection size. Lists
use opaque bounded cursors, never arbitrary offsets or caller-selected SQL
ordering. Initial limits are at most 100 records per request and at most 32
source/revision/audit items in a detail projection. Truncation is explicit.

Raw chat text, Provider prompts/responses, tool input/output payloads,
credentials, cookies, private platform IDs, filesystem paths, unrestricted
audit details, and unrestricted database fields are absent from P8 DTOs. There
is no browser switch to reveal them. Existing secret/platform redaction remains
a final display guard, not the primary field-selection mechanism.

## Mutation Lifecycle

No destructive command executes directly from a list row. The browser requests
a preview that contains only:

- the redacted action and exact scope;
- bounded affected-record counts and fingerprints;
- current lifecycle state and revision;
- expected durable effects and unavailable effects;
- whether rollback is supported and its boundary;
- a short expiry.

The server returns a random, single-use preview handle bound to session, actor,
scope, action, resource, expected state/revision, preview digest, and an expiry
capped at five minutes and the session expiry. Confirmation requires the same
session, exact CSRF token, an explicit confirm control, and the preview handle.
The shared service revalidates authority, scope, source, state, revision, and
policy in its mutation transaction. A preview is not authorization and does not
reserve the target.

B7C implements approval preview issuance. Its exact request body is
`{ "action": "approve" }`; its current-state precondition is
`pending_review`, and its expected state is `approved`. The unavailable effect
is the separate memory-record mutation, and approval has no direct memory-effect
rollback. B7D confirmation requires exact body
`{ "confirm": true, "previewHandle": HANDLE }`, consumes the preview before
freshness validation, recomputes and matches its trusted state, revision, and
digest, then invokes only the existing governed approval transition. Success is
`pending_review@N -> approved@(N+1)` with exactly one proposal revision and audit
event; it returns `200` with redacted proposal/revision/audit references and
states that no memory record was changed. Consumed, stale, or competing state is
fixed `409`; approval confirmation never applies or rolls back memory.

B8A implements rejection preview issuance through exact request body
`{ "action": "reject" }`. It binds a fresh handle to the fixed rejection action,
exact resource and scope, current `pending_review` state/revision, and distinct
rejection digest. It predicts `rejected` at the next revision, performs no
preview consumption, governance call, durable write, memory application, or
rollback.

B8B confirmation requires exact body
`{ "confirm": true, "previewHandle": HANDLE, "action": "reject" }`; omitting
the action retains the exact B7D approval meaning. It consumes only a
rejection-bound handle, recomputes and matches the rejection state, revision, and
digest, then invokes only the existing governed rejection transition. Success is
`pending_review@N -> rejected@(N+1)` with exactly one proposal revision and audit
event and a fixed redacted `200` result. Action mismatch and unknown handles are
fixed `404`; consumed, stale, or competing state is fixed `409`. No memory record,
maintenance application, or rollback is changed.

B9A application preview issuance accepts exact `{ "action": "apply" }` for
approved consolidation or decay proposals. Conflict requires exact
`{ "action": "apply", "retainedMemoryRef": REF }`, and the selected reference
must identify exactly one candidate already shown by the bounded detail DTO.
The resulting handle binds `memory.maintenance.apply`, exact session, actor,
scope/resource, current `approved` state/revision, and the full effect-plan
digest. Repeated identical plans receive fresh handles with stable digests;
changing the conflict selection changes the retained/superseded role
fingerprints and digest. Issuance performs no preview consumption, governance
call, durable write, memory mutation, retrieval change, application, or rollback.

B9B application confirmation consumes only an exact
`memory.maintenance.apply` handle. Consolidation and decay repeat no selection;
conflict repeats the visible `retainedMemoryRef` in the confirmation body. The
trusted resolver recomputes the approved-state plan from that body, and the
state, revision, conflict selection, and digest must match the consumed binding
before mutation. A mismatch consumes no domain effect and returns fixed `409`.
The handler then invokes `GovernanceService.applyMemoryMaintenanceProposal`
exactly once with server-owned local-admin authority, the consumed approved
revision, fixed `governance_http_application_confirmed` reason, and the resolved
retained memory ID only for conflicts.

Success atomically appends the existing apply proposal revision and audit,
retained/superseded/disabled memory revisions, and one effect-evidence link per
candidate. Superseded or disabled memories leave active retrieval immediately.
The fixed redacted `200` result reports the applied revision, original role
counts/fingerprints and selection, retrieval consequences, evidence references,
and `separate_confirmation_required` rollback boundary. It includes no raw
proposal, memory, source, scope, session, actor, or private content. Replay is
fixed `409`; rollback is not invoked or exposed by B9B.

B10A rollback preview issuance accepts only exact `{ "action": "rollback" }`
for an applied maintenance proposal. The response aggregates all candidates as
restored records, predicts the next rolled-back revision and fixed durable
effects, and reports `restored_records_included` as the retrieval consequence.
The fresh handle binds `memory.maintenance.rollback`, exact session, actor,
scope/resource, current `applied` state/revision, and the rollback-plan digest.
Issuance performs no preview consumption, governance rollback call, durable
write, memory mutation, or retrieval change.

B10B rollback confirmation consumes only an exact
`memory.maintenance.rollback` handle, recomputes and matches the applied state,
revision, restored-role plan, and digest, then invokes
`GovernanceService.rollbackMemoryMaintenanceProposal` exactly once with
server-owned local-admin authority, the consumed revision, and fixed
`governance_http_rollback_confirmed` reason. Success atomically appends the
existing rollback proposal revision and audit, one active memory revision and
restored effect-evidence link per candidate, and restores every candidate to
active retrieval. The fixed redacted `200` result reports the rolled-back
revision, original restored count/fingerprint, retrieval consequence, evidence
references, and terminal rollback boundary. Cross-action handles are fixed
`404`; replay, stale state, or competing rollback is fixed `409` with no partial
effect.

B11A expiration preview issuance accepts only exact `{ "action": "expire" }`
for a pending maintenance proposal. It binds a fresh handle to
`memory.maintenance.review.expire`, the exact session, actor, scope/resource,
current `pending_review` state/revision, and a distinct expiration digest. It
predicts `expired` at the next revision with the existing proposal-state,
proposal-revision, and audit effects, while reporting memory-record mutation as
unavailable and `expiration_does_not_apply_memory_effects` as the terminal
boundary. Issuance performs no preview consumption, governance call, durable
write, memory mutation, application, rollback, or retrieval change.

B11B expiration confirmation accepts only exact
`{ "confirm": true, "previewHandle": HANDLE, "action": "expire" }`. It consumes
the matching session/actor/action/scope/resource-bound B11A handle, recomputes
and matches the current pending state, revision, and expiration digest, then
invokes `GovernanceService.reviewMemoryMaintenanceProposal` exactly once with
server-owned local-admin authority, transition `expire`, the consumed revision,
and fixed `governance_http_expiration_confirmed` reason. Success appends only the
existing expired proposal revision and audit, returns the fixed redacted expired
result, and leaves memory records, memory revisions, apply/rollback evidence,
and active retrieval unchanged. Cross-action handles are fixed `404`; replay,
stale state/revision/digest, or competing review is fixed `409` with no partial
effect.

Success returns the redacted result plus audit/revision handles and, when
supported, a rollback action. Stale or competing state returns fixed `409`
evidence with no partial mutation. Missing and unauthorized resources remain
indistinguishable. Delete, supersede, maintenance rollback, privacy changes,
summary-policy changes, identity unlinking, retention, backup, and restore
planning all use this lifecycle. Irreversible or out-of-process effects state
that boundary before confirmation.

## Visual And Interaction Contract

The UI is a quiet, utilitarian operations tool rather than a marketing page.
Use a neutral light surface, graphite text, teal for the selected/primary state,
green for healthy outcomes, amber for attention, and red for destructive/error
states. Status always includes text or an icon plus text; color is never the
only signal. Avoid gradients, decorative illustration, oversized headings,
floating page-section cards, and a single-hue palette.

Use the system font stack, 16px minimum form text, tabular figures for metrics,
zero letter spacing, an 8px spacing rhythm, and radii no larger than 8px. Fixed
format counters, status cells, icon buttons, and toolbars reserve stable space
so loading or long labels do not shift adjacent controls. Labels wrap rather
than overlap or shrink with viewport width.

All controls are semantic HTML. Touch targets are at least 44 by 44 pixels with
at least 8px separation. Every input has a visible label and inline error. A
skip link, sequential headings, visible focus rings, route-change focus, modal
focus trap, `Escape` close path, and keyboard-operable tables/menus are required.
Loading longer than 300ms uses stable skeleton rows; completion and errors use
non-stealing `aria-live` regions. Reduced-motion disables nonessential motion.

Use familiar icons only after a single reviewed icon package is selected. Until
then, commands remain clearly text-labelled and no hand-drawn SVG icon set is
introduced. External fonts, scripts, stylesheets, analytics, and CDN assets are
not permitted.

Every view implements loading, empty, unavailable, session-expired, and bounded
error states. Review and mutation views additionally implement stale/conflict,
confirming, success, and rollback-unavailable states. Errors identify the next
operator action without exposing diagnostics.

## Dependency Strategy

The first HTTP/security slice uses Node built-ins and the existing Zod
dependency only. The first browser slice uses server-rendered semantic HTML,
one local CSS file, and small local ES modules. This adds no runtime or build
dependency and keeps the UI removable as one optional boundary.

React, Vue, a component framework, Tailwind, a chart library, and an icon
package are not justified for the initial bounded views. If later interaction
complexity demonstrates a concrete need, that dependency change must be its own
reviewed slice with lockfile review, bundle/build ownership, accessibility
evidence, and rollback. Charts are not required for aggregate health; compact
tables and labelled values are the accessible primary representation.

## HTTP Failure Semantics

| Condition | Status | Required effect |
|---|---:|---|
| Invalid login credential | `401` | Fixed response, no cookie/session/service call. |
| Missing, malformed, unknown, or expired session | `401` | Fixed response, no scope/service call. |
| Missing or wrong origin/CSRF on mutation | `403` | Fixed response, no body/scope/service call where possible. |
| Malformed body, route input, or scope syntax | `400` | Fixed response, no service call. |
| Missing, unauthorized, expired, or cross-boundary scope/resource | `404` | Indistinguishable response, no mutation. |
| Stale expected state/revision or consumed preview | `409` | Fixed conflict response, no partial mutation. |
| Body too large | `413` | One terminal response, connection drained/closed, no service call. |
| Body timeout | `408` | One terminal response, no service call. |
| Bounded service unavailable | `503` | Fixed response, no stack/path/raw diagnostic. |

QQ-role, actor, scope-kind, forwarded-host, and forwarded-address headers are
ignored. Reverse-proxy trust is outside P8.

B14A registers read-only `/activity/model-invocations` as an explicitly
authenticated-unscoped system-wide projection with purpose
`governance.activity.model_invocations.read`. It rejects a scope header and
all query strings, does not issue or resolve a scope/resource handle, and
returns only the existing aggregate fields and latency/unknown-usage semantics.
B14B registers read-only `/activity/worker-heartbeats` through the same
authenticated-unscoped boundary with purpose
`governance.activity.worker_heartbeats.read`. It rejects the same inputs and
calls the existing shared list with no options, preserving the 100-row default,
mixed-direction stable ordering, hidden details, ISO date serialization,
nullable current-job field, and recursive identifier redaction.
B14C registers read-only `/activity/jobs` through that boundary with purpose
`governance.activity.jobs.read`. It also rejects all caller-controlled filters
and calls the shared list with no options, preserving the 100-row default,
scheduled/created stable ordering, hidden payload/result, ISO date
serialization, nullable operational fields, and recursive identifier and
diagnostic redaction.
B14D registers read-only `/activity/tool-calls` through that boundary with
purpose `governance.activity.tool_calls.read`. It rejects the same inputs and
calls the shared list with no options, preserving the 100-row default,
created/ID newest-first ordering, hidden input/output, ISO date serialization,
nullable diagnostic/timing fields, recursive identifier/classification/
diagnostic redaction, and the persisted secrets-redacted signal.
B14E registers read-only `/activity/action-decisions` through that boundary with
purpose `governance.activity.action_decisions.read`. It rejects the same inputs
and calls the shared list with no options, preserving the 100-row default,
created/ID newest-first ordering, hidden actions, ISO date serialization,
nullable evaluator outcome, exact action count, and recursive identifier/
classification/reason/suppressor redaction.
B14F registers read-only `/activity/action-executions` through that boundary
with purpose `governance.activity.action_executions.read`. It rejects the same
inputs and calls the shared list with no options, preserving the 100-row default,
execution-time/ID newest-first ordering, hidden audit entry, ISO date
serialization, nullable executed/downgrade/error fields, retained audit level,
and recursive identifier/classification/diagnostic redaction.
B14G registers read-only `/activity/job-attempts` through that boundary with
purpose `governance.activity.job_attempts.read`. It rejects the same inputs and
calls the shared list with no options, preserving the 100-row default,
start-time/ID newest-first ordering, hidden result, exact attempt number, ISO
date serialization, nullable completion/heartbeat/error fields, and recursive
identifier/classification/diagnostic redaction.
B14H registers read-only `/activity/event-processing-failures` through that
boundary with purpose `governance.activity.event_processing_failures.read`. It
rejects the same inputs and calls the shared list with no options, preserving the
100-row default, occurrence-time/ID newest-first ordering, hidden details, ISO
date serialization, nullable source/turn/conversation/hash fields, exact fixed
hash evidence, and recursive identifier/classification/diagnostic redaction.
B14I registers read-only `/activity/audit` through that boundary with purpose
`governance.activity.audit.read`. It rejects the same inputs and calls the shared
list with no options, preserving the 100-row default, timestamp/ID newest-first
ordering, hidden details, ISO date serialization, nullable actor/risk/evaluator
fields, default details-redacted/redacted signals, and recursive identifier/
classification/summary redaction.
B15C registers read-only `/privacy/scopes` through that boundary with purpose
`governance.privacy.preferences.scopes`. It rejects query strings and scope
headers, calls only the B15A catalog, and binds each trusted issuer call to the
current session digest/expiry, exact user scope, and
`governance.privacy.preferences.read`. Handles are stable within that live
binding and fail for maintenance review.
B15D registers scoped read-only `/privacy/preferences` with purpose
`governance.privacy.preferences.read`. The shared boundary rejects queries and
invalid authority before dispatch; the handler calls only
`listPrivacyPreferencesForScope(scope)` and returns its fixed bounded page.
B16B registers read-only `/memory/scopes` through the authenticated-unscoped
boundary with purpose `governance.memory.records.scopes`. It rejects query
strings and scope headers, calls only the B16A catalog, and binds each trusted
issuer call to the current session digest/expiry, exact scope, and
`governance.memory.records.read`. Handles are stable within that live binding
and fail for maintenance and Privacy purposes. B16D registers scoped read-only
`/memory/records` with the Memory-read purpose. The shared boundary rejects
queries and invalid authority before dispatch; the handler calls only
`listMemoryRecordResourceHandlePage(scope, issuer)`. The issuer binds only
B17B-selected records to the callback's current session digest/expiry, the
Memory-read purpose, kind `memory_record`, and normalized exact scope; the route
returns that bounded page unchanged. B17A's internal-ID detail method remains
isolated from raw HTTP selectors and receives only B17D's resource-registry ID
plus resolved exact scope. B17D registers the matching read-only resource route;
the shared boundary rejects invalid scope or resource authority before B17A and
maps a missing scoped record to `404`. B20B registers the preview-only POST at
that resource path; invalid session/Origin/CSRF/scope/resource/body authority
fails before B20A and preview issuance, while a valid projection receives one
fresh action/state/revision/digest-bound preview handle. Confirmation, preview
consumption, and durable Memory mutation remain absent.
B18B registers read-only `/explain/scopes` through the authenticated-unscoped
boundary with purpose `governance.explain.turns.scopes`. It rejects query
strings and scope headers, calls only B18A, and binds each trusted issuer call
to the current session digest/expiry, exact private/group conversation scope,
and `governance.explain.turns.read`. Handles are stable within that live binding
and fail for Memory, Privacy, and maintenance purposes. B18D registers scoped
read-only `/explain/turns` with that same read purpose. The shared boundary
rejects invalid authority before query dispatch. B19B passes only the resolved
exact conversation scope to B19A, whose trusted issuer binds selected turns to
the callback session digest/expiry, same purpose, `explain_turn` kind, internal
turn ID, and normalized exact scope. The response is B19A's fixed page, and
B18C is not called directly. B19D registers the matching read-only resource
route. The shared boundary rejects invalid scope or resource authority before
B19C and maps a resolved missing turn detail to fixed `404`; the handler passes
only the resolved exact scope and registry-owned internal turn ID. ContextBuilder
rebuild and every Explain mutation route remain absent.

B20A adds only the HTTP-disabled exact-scope Memory-record forget preview owned
by `GovernanceQueryService`. It accepts a clean bounded internal record ID,
applies the existing exact-scope predicate, and requires a non-deleted lifecycle
state plus a positive safe integral latest revision. The fixed projection
contains only action `memory.record.forget`, a forget-purpose-bound record
reference, scope kind, current and expected lifecycle revisions, fixed durable
state/revision/audit effects, immediate deleted-record retrieval exclusion, a
separately confirmed restore boundary, and a domain-separated digest. Missing,
cross-scope, malformed, deleted, revisionless, or unsafe-revision records return
no preview. Raw record and owner identifiers, scope values, content, provenance,
evaluator/session data, handles, routes, confirmations, writes, and retrieval
changes remain absent; existing CLI/QQ forget operations remain unchanged.

B20B exposes only that projection through mutation-marked
`POST /governance/api/v1/memory/records/:resourceHandle`. It reuses the current-
session Memory scope/resource bindings and generic Origin/CSRF/body boundary,
accepts only `{ "action": "forget" }`, and passes only the resolved exact scope
and registry-owned internal record ID to B20A. A valid preview is returned with
a fresh opaque expiry and bound in the existing single-use registry by session,
actor, action, resource kind/ID, exact scope, current state/revision, and digest.
No confirmation route consumes that authority, and no service, audit, record,
revision, FTS, or retrieval mutation occurs.

B20C extends the shared local-admin forget operation with an expected-snapshot
overload while preserving its existing CLI string call and QQ behavior. The
operation validates the internal record ID, normalized exact non-tool scope,
non-deleted lifecycle state, positive safe revision, and bounded reason code,
then compares the record's exact scope, current state, and latest revision in
the same immediate transaction as the existing delete transition. Missing,
deleted, or cross-scope records are concealed; stale or malformed revision
evidence is write-free. An exact match appends the existing delete revision and
redacted audit and becomes retrieval-ineligible immediately. No HTTP route yet
consumes a preview handle or invokes this expected-snapshot overload.

B20D registers only mutation-marked
`POST /governance/api/v1/memory/records/:resourceHandle/confirm`. The shared
boundary resolves the exact current-session Memory scope and resource authority
and accepts only `{ "confirm": true, "previewHandle": HANDLE }`. The handler
consumes the forget preview once, recomputes B20A for the registry-owned record,
requires exact state/revision/digest parity, and calls only B20C with the exact
scope, bound snapshot, and fixed local-admin reason. Unknown authority is
concealed as not found; stale, drifted, or reused authority conflicts. Success
returns only the forget-purpose record reference, scope kind, deleted revision,
fixed revision/audit/retrieval effects, and the separate-restore boundary. The
operation appends one delete revision and one redacted audit and immediately
excludes an active record from retrieval. Raw identifiers, caller-controlled
reason/scope/state/revision, direct SQL, and restore remain absent.

B21A adds only the HTTP-disabled shared local-admin Memory restore operation.
Its legacy string call preserves the existing `enable-memory`/`restore-memory`
actor, reason, audit, output, revision, and retrieval effects, and both CLI
aliases now delegate through that owner. Its expected-snapshot overload accepts
only a clean internal record ID, exact non-tool scope, current `disabled`,
`rejected`, or `deleted` state, positive safe latest revision, and bounded
reason code. It compares scope, state, and revision in the same immediate
transaction as the existing repository `-> active` transition. Missing,
cross-scope, or non-restorable records are concealed; malformed or drifted
state/revision evidence is write-free. Success appends one restore revision and
one redacted audit and makes a normal record immediately active-retrievable.
Restore preview, handle issuance, confirmation, and HTTP routes remain absent.

B21B adds only the HTTP-disabled exact-scope Memory-record restore preview owned
by `GovernanceQueryService`. It accepts a clean bounded internal record ID,
applies the existing exact-scope predicate, and requires current `disabled`,
`rejected`, or `deleted` state plus a positive safe integral latest revision.
The fixed projection contains only action `memory.record.restore`, a restore-
purpose-bound record reference, scope kind, current and expected lifecycle
revisions, fixed state/revision/audit effects, immediate restored-record
retrieval inclusion, a separately confirmed forget boundary, and a domain-
separated digest. Missing, cross-scope, malformed, non-restorable,
revisionless, or unsafe-revision records return no preview. Raw record and owner
identifiers, scope values, content, provenance, evaluator/session data,
handles, routes, confirmations, writes, and retrieval changes remain absent;
B20A-D, B21A, and existing CLI/QQ behavior remain unchanged.

B21C exposes only that restore projection through the existing mutation-marked
`POST /governance/api/v1/memory/records/:resourceHandle`. It reuses the current-
session Memory scope/resource bindings and generic Origin/CSRF/body boundary,
accepts only exact `{ "action": "restore" }`, and passes only the resolved
exact scope and registry-owned internal record ID to B21B. A valid projection
is returned with fresh opaque expiry and bound in the existing single-use
registry by session, actor, restore action, resource kind/ID, exact scope,
current restorable state/revision, and digest. Unknown or non-restorable records
remain concealed. The forget action is unchanged, the existing confirmation
route accepts only forget authority, and no restore preview consumption,
service call, audit, lifecycle/revision write, or retrieval change occurs.

B21D extends only the existing Memory-record `/confirm` route. The unchanged
two-key confirmation remains forget-only; restore requires exact
`{ "confirm": true, "previewHandle": HANDLE, "action": "restore" }`. The
handler consumes only matching current-session restore authority once,
recomputes B21B, compares its current state, revision, and digest with the
consumed binding, and invokes only B21A with that expected snapshot and the
fixed HTTP reason code. Unknown or mismatched authority is concealed, while a
reused or drifted preview conflicts. Success returns only the fixed record
reference and scope kind, active state and next revision, copied durable and
retrieval evidence, `restore` revision plus `memory.restore` audit evidence,
and the separately confirmed forget boundary. Raw identifiers, content,
provenance, evaluator/session data, and unrestricted fields remain absent;
B20D forget and both existing CLI aliases are unchanged.

B22B adds only the HTTP-disabled exact-user Privacy preference-change preview
owned by `GovernanceQueryService`. It accepts one valid user scope, one fixed
preference type, and one fixed target state, verifies that the canonical user
exists, and reads only that exact preference. A missing row supplies effective
state `opted_in` with `implicit_default` version evidence; a stored row supplies
its validated state and bounded update timestamp. An effective no-op or invalid
scope, user, type, state, persisted state, or timestamp returns no preview. The
fixed response contains only action `privacy.preference.change`, preference
type, current and target state/version evidence, the preference-upsert and audit
writes, immediate enforcement, semantic rollback to the current state through
a separate confirmation boundary, and a domain-separated SHA-256 digest. Raw
user/updater identifiers, reasons, actor context, repository rows, authority,
routes, service calls, confirmations, writes, and enforcement changes remain
absent.

B22C exposes only B22B through mutation-marked
`POST /governance/api/v1/privacy/preferences`. It reuses the current-session
`governance.privacy.preferences.read` scope authority, accepts only exact
`{ "action": "change", "preferenceType": TYPE, "targetState": STATE }`, and
passes only the resolved exact user scope and fixed body values to B22B. A null
projection stays concealed. Success returns the unchanged projection plus a
fresh opaque expiry and binds action `privacy.preference.change`, resource kind
`privacy_preference`, the preference type, exact scope, current effective state,
positive stored-timestamp-or-default version, and digest in the existing
single-use registry. Authentication, query, Origin/CSRF, body, and scope failures
precede query or issuance. B22C itself performs no confirmation consumption or
service call; the separate B22E route is the only consumer of this authority.

B22D adds only an HTTP-disabled expected-snapshot overload to the B22A shared
local-admin Privacy mutation. The legacy service and repository calls retain
their exact input, result, timestamp, deferred-transaction, redaction, upsert,
audit, enforcement, and error behavior. The new call accepts one clean canonical
user ID, fixed preference type and target state, different expected effective
state, bounded reason code, optional valid clock, and an exact version of either
`implicit_default` with null timestamp or `stored_preference` with its update
timestamp. The repository verifies user existence and compares absence or the
stored state/timestamp inside the same immediate transaction as the existing
redacted upsert and `privacy.preference_set` audit. A stored `opted_in` row is
never equivalent to an absent effective opt-in, including when its timestamp is
`1`. Stored transitions advance beyond the prior timestamp under an equal or
rolled-back clock. Missing users are concealed; invalid, no-op, source-mismatched,
or stale evidence is write-free. Success returns only `updated` and the new
timestamp and is immediately visible to enforcement. The overload itself adds no
route or response projection; B22E owns confirmation consumption and invokes it
only after recomputing this exact snapshot.

B22E adds only the separate exact-scope confirmation route
`POST /governance/api/v1/privacy/preferences/confirm`. The shared HTTP boundary
requires the current-session Privacy scope, exact Origin/CSRF, and exact
`{ "confirm": true, "previewHandle": HANDLE, "preferenceType": TYPE,
"targetState": STATE }`. It consumes the B22C
`privacy.preference.change` / `privacy_preference` binding once, recomputes the
B22B projection and digest, and compares effective state plus the positive
stored-timestamp-or-default version before invoking B22D with the fixed local-
admin reason code. Unknown authority is concealed; reuse, row/state/source/
timestamp drift, digest drift, and an atomic race are fixed conflicts. Success
returns only action, `updated`, preference type, new stored version, durable
upsert/audit effects, immediate enforcement, `privacy.preference_set` evidence,
and the semantic rollback boundary. Raw identifiers, reasons, session values,
preview bindings, and unrestricted rows remain absent; GET, preview issuance,
CLI behavior, and all other route purposes are unchanged.

B24A adds only the HTTP-disabled exact-group summary-policy status projection
`GovernanceQueryService.getGroupSummaryPolicyForScope`. It accepts one valid
group scope, reads only that exact durable policy, and returns effective
enabled/disabled state, stored-evidence presence, finite generation and
eligibility evidence, and dates. An absent row is the effective default-off
state. Raw group, actor, audit, job, conversation, and platform identifiers are
absent; non-group, malformed, or invalid durable evidence returns no projection
without widening the read. CLI `memory-summary status` delegates to this fixed
projection without changing its output, while enable/disable remains on the
existing `GovernanceService` mutation and preserves generation, cancellation,
and audit behavior. B24A adds no catalog, handle, route, preview, confirmation,
write, schema, dependency, or browser behavior.

B24B adds only the HTTP-disabled exact-group summary-policy scope catalog
`GovernanceQueryService.listGroupSummaryPolicyScopeHandles`. It discovers
distinct canonical `qq-group-<5..12 digits>` scopes from valid group chat
evidence whose conversation and group identifiers match, plus durable policy
evidence so both observed default-off and policy-only groups remain selectable.
The catalog orders scopes by their newest evidence and then group identifier,
probes 101 distinct scopes, and issues at most 100. Only the exact group scope is
passed to the trusted issuer. Each result contains a domain-separated
fingerprint, fixed group kind and `Group summary policy` label, opaque handle,
numeric expiry, and catalog truncation; raw group/platform/name/policy data and
issuer extras remain absent. B24B adds no route, registry wiring, status read,
preview, confirmation, mutation, audit, schema, dependency, CLI, or browser
behavior.

B24C registers only authenticated-unscoped read-only
`GET /governance/api/v1/group-summary/scopes` with discovery purpose
`governance.group_summary_policy.scopes`. The shared boundary rejects
unauthenticated access, queries, and scope headers before B24B or the issuer. A
current session delegates only to B24B and binds each exact group scope to that
session digest and expiry plus purpose
`governance.group_summary_policy.status.read`. The unchanged catalog remains
identifier-free and repeated reads are stable and write-free. B24C adds no
status or mutation route, query-service behavior, resource/preview authority,
body, CSRF, schema, dependency, CLI, or browser behavior.

B24D registers only exact-scope read-only
`GET /governance/api/v1/group-summary/policy` with purpose
`governance.group_summary_policy.status.read`. The shared boundary rejects
unauthenticated access, queries, and missing, malformed, unknown, cross-session,
or cross-purpose handles before B24A. A valid request passes only the resolved
exact group scope to `getGroupSummaryPolicyForScope` and returns its fixed
identifier-free stored or effective-default-off projection; a defensive null
maps to fixed `404`. Repeated reads are stable and write-free. B24D adds no raw
selector, body, POST, preview, confirmation, mutation, audit, resource handle,
query-service, schema, dependency, CLI, or browser behavior.

B24E adds only the HTTP-disabled read-only
`GovernanceQueryService.getGroupSummaryPolicyChangePreviewForScope` and action
`group.summary_policy.change`. It accepts a resolved exact group scope plus
target `enabled` or `disabled`, delegates current-state inspection only to B24A,
and returns no preview for invalid evidence, a no-op target, or an exhausted
stored generation. A valid preview contains only effective current state,
stored-evidence and generation/date version, target state and next generation,
the existing policy/audit effects, enable no-backfill or disable immediate-
enforcement/pending-job-cancellation consequences, a separate-confirmation
semantic rollback target, and a versioned domain-separated digest. It contains
no group, actor, audit/job ID, session, platform, secret, or unrestricted
field. B24E adds no handle, route, preview authority, owner call, mutation,
audit, schema, dependency, CLI, QQ, or browser behavior.

B24F adds only an HTTP-disabled expected-snapshot overload to the existing
`GovernanceService.setGroupSummaryPolicyAsLocalAdmin` and repository
`setEnabled` owners. Legacy service, CLI, QQ, and repository calls retain their
existing boolean target, authority, timestamp, generation, cancellation, audit,
result, and error behavior. The new call accepts one canonical group ID, an
opposite current and target state, a bounded reason code, an optional safe clock,
and an exact version of either `implicit_default` with null generation/update
time or `stored_policy` with its positive safe generation and update time. The
repository distinguishes an absent default-off policy from a stored disabled
row and compares stored state, generation, and update time inside the same
immediate transaction as the existing policy upsert, exact-group pending-summary
job terminalization, and redacted `group.summary_policy_changed` audit append.
Success advances generation once, preserves the enable no-backfill ingress
fence, applies disable enforcement/cancellation immediately, and returns only
fixed `updated` transition evidence. Invalid, no-op, drifted, disappeared,
exhausted-generation, or unadvanceable-time evidence returns `stale` without a
write. Audit failure rolls back the policy and cancellation. B24F adds no preview
authority, confirmation consumption, HTTP route, schema, dependency, CLI/QQ
surface, or browser behavior.

B24G exposes only B24E through mutation-marked
`POST /governance/api/v1/group-summary/policy` under the existing
`governance.group_summary_policy.status.read` exact-group scope authority. The
shared boundary rejects unauthenticated access, queries, invalid Origin/CSRF,
non-JSON or bounded-body failures, and missing, malformed, unknown,
cross-session, or cross-purpose handles before B24E or issuance. The handler
accepts only exact `{ "action": "change", "targetState": STATE }`, passes the
resolved group scope and fixed enabled/disabled target to B24E, and conceals a
null projection. Success returns the unchanged projection plus fresh opaque
expiry and binds `group.summary_policy.change`, resource kind
`group_summary_policy`, fixed resource `policy`, exact scope, current state,
positive current-generation-or-default version, and digest in the existing
single-use registry. Repeated previews remain write-free. B24G adds no
confirmation route, authority consumption, B24F/service/repository call,
policy/job/audit write, enforcement change, schema, dependency, CLI/QQ surface,
or browser behavior.

B24H adds only mutation-marked
`POST /governance/api/v1/group-summary/policy/confirm` under the same
`governance.group_summary_policy.status.read` exact-group authority. The shared
boundary rejects unauthenticated access, queries, invalid Origin/CSRF, malformed
or oversized JSON, and invalid scope authority before the handler. The handler
accepts only exact `{ "confirm": true, "previewHandle": HANDLE,
"targetState": STATE }`, consumes matching current-session
`group.summary_policy.change` / `group_summary_policy` / fixed `policy` /
exact-scope authority once, and recomputes B24E. It compares current state,
positive generation-or-default registry version, and digest before converting
the implicit-default or stored-policy version for B24F. Only
`setGroupSummaryPolicyAsLocalAdmin` is invoked, with fixed server-owned reason
`governance_http_group_summary_policy_change_confirmed`. Unknown or mismatched
authority is concealed as `404`; reuse, drift, no-op, and B24F stale evidence
are fixed `409`. Success returns only action/outcome, stored state, generation,
eligibility, copied durable and enforcement effects, fixed audit/generation/
update/cancellation evidence, and the semantic rollback boundary. Group, actor,
reason, audit/job IDs, session, preview binding, and raw rows remain absent.
B24H adds no query, service, repository, registry, schema, dependency, CLI/QQ,
browser, Provider, or live behavior.

## Browser Completion Checkpoint (2026-07-31)

The local same-origin browser now covers every governance HTTP contract that is
currently complete and browser-safe. In addition to Overview, Activity, Memory
Records/Review, Explain, approval, rejection, application, rollback, expiration,
and record forget/restore, it provides strict preview-confirm controllers for
Privacy preference changes, Group-summary policy changes, Display-profile
redaction, exact QQ platform-account unlink, verified backup creation, and
restore-handoff preparation. The last two workflows are authenticated-unscoped:
their POST transport sends only JSON content type and the in-memory CSRF token,
never `X-LetheBot-Scope`.

Platform-account unlink accepts the raw QQ account ID only in a transient
password-style operator input. Preview clears that input and retains only the
session-bound resource/preview handles, expiry, and bounded fingerprint in a
private closure. Neither the raw ID nor authority is rendered or persisted.
Confirmation is exact `{ "confirm": true, "resourceHandle": HANDLE,
"previewHandle": HANDLE }`; the irreversible boundary remains
`platform_account_relink_not_available`.

Operations keeps verified-backup and restore-handoff authority action-bound and
in memory. Backup confirmation retains the opaque `backupRef` only long enough
to request a restore-handoff preview and confirmation; the reference, preview
digests/handles, private path, and handoff ID never enter the DOM. Restore
confirmation creates only a durable handoff. The browser explicitly renders
`stopped_service_only` and “No in-process restore”; it does not stop the service
or execute restore.

All response normalizers reject unknown keys and incoherent values. Display
redaction now additionally requires a non-null canonical `redactedAt`, rejects
`openNicknameHistoryRowsClosed` above the affected history-row count, and
re-enables fresh preview after consumed-authority confirmation failure. Mutation
buttons suppress duplicate preview/confirmation dispatch, and navigation,
logout/session expiry, selection changes, refresh, expiry timers, and stale
responses clear or invalidate private authority.

Deterministic Chromium covers the exact request bodies and successful flows for
all browser mutations, plus 1440×1000, 390×844, and 375×812 layout checks across all nine
top-level views. The QA asserts valid `aria-controls`/`aria-labelledby`
relationships, keyboard Tab focus, WCAG AA contrast for the fixed semantic color
pairs, reduced-motion transition suppression, a synthetic login-only PNG capture,
44px minimum controls, no view/body
horizontal overflow, same-origin resources, no captured runtime errors, and no
raw ID/handle/digest/reference leakage. Current compact served sizes are:
`app.js` 28,257 bytes (SHA-256
`fe973f6b55d903823c09a7bada49850751014ed8048411a164a3a6f0d35a281f`),
`administration.js` 25,351 bytes (SHA-256
`381863222bba33fb7f3af647a4df24a04b970e0d1e6c3b1630d612f6e353f176`),
and `memory.js` 65,334 bytes. Every asset remains below 65,536 bytes; the
initial HTML+CSS+`app.js` payload is 53,816 bytes, below the fixed 60,000-byte
budget.

The final local gate ran `pnpm release:check` in a data-excluded isolated copy
and exited successfully. Typecheck, ESLint, build, release preflight, the full
Vitest run, and `git diff --check` all passed. Preflight validated four required
files plus the pnpm/lockfile and schema contract; Vitest reported 137 passed and
one skipped test file, with 2,869 passed and 10 skipped tests (2,879 total). A
separate `git diff --check` against the current working tree was also clean.
This evidence is local and synthetic; it does not broaden the live authorization
boundary below.

Retention remains a prerequisite, not an omitted browser button. No complete
browser-facing retention policy/snapshot/audit/preview/confirmation contract is
currently registered, so the browser does not invent irreversible cleanup
semantics. Real Provider/QQ use, deployment/restart, stopped-service restore
execution, soak, production screenshots, and live accessibility sign-off remain
outside this local deterministic checkpoint and require separate authorization.

## Slice And Verification Order

1. `GOV-UX-01A0`: this contract and documentation navigation only.
2. `GOV-UX-01A1`: create `tests/integration/governance-http.test.ts` first;
   prove auth/session/CSRF/scope negative paths fail before implementation, then
   implement only the isolated listener security boundary with no domain route.
3. `GOV-UX-01A2`: add exact default-off loopback configuration and wire the
   empty-route boundary into reciprocal application startup/shutdown cleanup.
4. `GOV-UX-01B1`: extract the system-wide aggregate overview query and keep its
   HTTP route disabled.
5. `GOV-UX-01B2A`: extract the existing memory-review list and summary reads,
   retaining their CLI behavior and keeping them HTTP-disabled.
6. `GOV-UX-01B2B`: add fixed exact-scope normalized maintenance-review list and
   detail projections while retaining empty HTTP routes.
7. `GOV-UX-01B3/01B4/01B5A/01B5B/01B5C`: add the bounded scope catalog,
   standalone handle registry, exact session lifecycle ownership, disjoint
   discovery dispatch, and authenticated `/scopes` issuance.
8. `GOV-UX-01B6A/01B6B/01B6C`: expose the shared system-wide aggregate
   projection through authenticated `/overview`, then the exact-scope
   maintenance-review list through `/memory-reviews`, then its session-bound
   resource-handle detail route.
9. `GOV-UX-01B7A/01B7B/01B7C/01B7D`: add the standalone single-use
   confirmation-preview handle owner, exact HTTP session lifecycle ownership,
   one bounded maintenance-approval preview route, then its exact confirmation
   through the existing governed review transition without memory application.
10. `GOV-UX-01B8A`: add the bounded maintenance-rejection preview through the
    existing detail POST without confirmation or durable mutation.
11. `GOV-UX-01B8B`: add exact maintenance-rejection confirmation through the
    existing governed review transition without memory application.
12. `GOV-UX-01B9A`: add the bounded maintenance-application preview for
    consolidation, decay, and an explicit conflict choice without confirmation
    or durable mutation.
13. `GOV-UX-01B9B`: add exact application confirmation through the existing
    governed operation while retaining a separately confirmed rollback boundary.
14. `GOV-UX-01B10A`: add the bounded applied-maintenance rollback preview without
    confirmation, preview consumption, durable mutation, or retrieval change.
15. `GOV-UX-01B10B`: add exact rollback confirmation through the existing
    governed operation with restored retrieval and fixed redacted evidence.
16. `GOV-UX-01B11A`: add the bounded pending-review expiration preview without
    confirmation, preview consumption, or durable mutation.
17. `GOV-UX-01B11B`: add exact expiration confirmation through the existing
    governed review transition without memory application.
18. `GOV-UX-01B12A`: move bounded audit inspection and redaction behind the
    shared query service while preserving CLI behavior and keeping HTTP absent.
19. `GOV-UX-01B12B`: move exact memory provenance inspection and redaction behind
    the shared query service while preserving CLI behavior and keeping HTTP absent.
20. `GOV-UX-01B12C`: move the database-backed memory-record list behind the
    shared query service while preserving the repository-only CLI fallback and
    keeping HTTP absent.
21. `GOV-UX-01B12D`: move the visible memory-export projection behind the shared
    query service while preserving the repository-only CLI fallback and keeping
    HTTP absent.
22. `GOV-UX-01B12E`: move the model-invocation summary behind the shared query
    service while preserving ledger/latency semantics and keeping HTTP absent.
23. `GOV-UX-01B12F`: move bounded tool-call inspection behind the shared query
    service while preserving context-explanation ordering and keeping HTTP absent.
24. `GOV-UX-01B12G`: move bounded action-decision inspection behind the shared
    query service while preserving context-decision selection and keeping HTTP absent.
25. `GOV-UX-01B12H`: move bounded action-execution inspection behind the shared
    query service while preserving context-explanation ordering/effect labels
    and keeping HTTP absent.
26. `GOV-UX-01B12I`: move bounded job inspection behind the shared query service
    while preserving job-attempt and worker behavior and keeping HTTP absent.
27. `GOV-UX-01B12J`: move bounded job-attempt inspection behind the shared query
    service while preserving attempt persistence and worker behavior and keeping
    HTTP absent.
28. `GOV-UX-01B12K`: move bounded worker-heartbeat inspection behind the shared
    query service while preserving heartbeat persistence and worker behavior and
    keeping HTTP absent.
29. `GOV-UX-01B12L`: move bounded event-processing-failure inspection behind the
    shared query service while preserving failure persistence and turn behavior
    and keeping HTTP absent.
30. `GOV-UX-01B12M`: move bounded privacy-preference inspection behind the shared
    query service while preserving preference writes, audits, and enforcement
    and keeping HTTP absent.
31. `GOV-UX-01B13A`: move the stored Explain/context-trace read over
    `ContextTraceRepository.findByTurnId` behind the shared query service with
    a pure fixed projection and CLI identity delegation; preserve rebuild,
    action/tool composition, and keep HTTP absent.
32. `GOV-UX-01B13B`: move bounded Explain action-decision, action-execution,
    and tool-call reads and pure projections behind the shared query service;
    preserve linked selection, ordering, redaction, reaction labels, and CLI
    output while keeping HTTP absent.
33. `GOV-UX-01B13C`: move the explicit/latest Explain turn-resolution read and
    conversation metadata projection behind the shared query service; preserve
    CLI validation, rebuild inputs, and stored-trace preference while keeping
    HTTP absent.
34. `GOV-UX-01B14A`: expose the payload-free model-invocation aggregate through
    authenticated read-only `/activity/model-invocations`; preserve the shared
    summary projection and keep invocation payloads/identifiers out of the
    response.
35. `GOV-UX-01B14B`: expose the bounded default worker-heartbeat list through
    authenticated read-only `/activity/worker-heartbeats`; preserve shared
    ordering, limits, date conversion, hidden details, and identifier redaction.
36. `GOV-UX-01B14C`: expose the bounded default job list through authenticated
    read-only `/activity/jobs`; preserve shared ordering, limits, dates, hidden
    payload/result, nullable fields, and identifier/diagnostic redaction.
37. `GOV-UX-01B14D`: expose the bounded default tool-call list through
    authenticated read-only `/activity/tool-calls`; preserve shared ordering,
    limits, dates, hidden input/output, nullable fields, and redaction.
38. `GOV-UX-01B14E`: expose the bounded default action-decision list through
    authenticated read-only `/activity/action-decisions`; preserve shared
    ordering, limits, dates, hidden actions, nullable fields, and redaction.
39. `GOV-UX-01B14F`: expose the bounded default action-execution list through
    authenticated read-only `/activity/action-executions`; preserve shared
    ordering, limits, dates, hidden audit entries, nullable fields, and redaction.
40. `GOV-UX-01B14G`: expose the bounded default job-attempt list through
    authenticated read-only `/activity/job-attempts`; preserve shared ordering,
    limits, dates, hidden results, nullable fields, and redaction.
41. `GOV-UX-01B14H`: expose the bounded default event-processing-failure list
    through authenticated read-only `/activity/event-processing-failures`;
    preserve shared ordering, limits, hashes, dates, hidden details, nullable
    fields, and redaction.
42. `GOV-UX-01B14I`: expose the bounded default audit list through authenticated
    read-only `/activity/audit`; preserve shared ordering, limits, dates, hidden
    details, nullable fields, redaction signals, and recursive redaction.
43. `GOV-UX-01B15A`: add the bounded canonical-user Privacy scope catalog and
    trusted future-purpose handle issuance behind the shared query service;
    preserve cross-purpose isolation and keep HTTP routes absent.
44. `GOV-UX-01B15B`: add the exact-user bounded Privacy preference page behind
    the shared query service; strip owner/updater identifiers and keep HTTP
    routes absent.
45. `GOV-UX-01B15C`: expose only the purpose-specific Privacy user-scope catalog
    through authenticated read-only `/privacy/scopes`; preserve legacy scope
    discovery and defer the Privacy data route to a separate slice.
46. `GOV-UX-01B15D`: expose only the exact-user bounded Privacy preference page
    through scoped read-only `/privacy/preferences`; preserve discovery,
    maintenance isolation, owner-identifier removal, and all mutation boundaries.
47. `GOV-UX-01B16A`: add the bounded record-backed Memory scope-handle catalog
    behind the shared query service; normalize before the limit, preserve stable
    fingerprints, omit tool/malformed rows, and keep HTTP routes absent.
48. `GOV-UX-01B16B`: expose only that purpose-specific catalog through
    authenticated read-only `/memory/scopes`; preserve maintenance/Privacy
    purpose isolation and defer Memory data routes.
49. `GOV-UX-01B16C`: add the fixed bounded exact-scope Memory-record page behind
    the shared query service; hide raw identifiers and restricted text, preserve
    every lifecycle state, and keep the Memory data route absent.
50. `GOV-UX-01B16D`: expose only the exact-scope bounded Memory-record page
    through scoped read-only `/memory/records`; preserve purpose isolation and
    keep record-detail and mutation routes absent.
51. `GOV-UX-01B17A`: add the fixed bounded exact-scope Memory provenance detail
    behind the shared query service; preserve B12B/B16C behavior, omit raw
    identifiers and snapshots, and keep handles and HTTP detail routes absent.
52. `GOV-UX-01B17B`: add the HTTP-disabled bounded exact-scope Memory-record
    resource-handle page; preserve B16C parity and keep application/registry
    wiring plus HTTP detail routes absent.
53. `GOV-UX-01B17C`: wire the existing `/memory/records` route to B17B through
    current-session Memory-read `memory_record` bindings; preserve every route
    boundary and keep Memory detail absent.
54. `GOV-UX-01B17D`: expose B17A through one read-only Memory-record resource
    route; require exact current-session scope and resource authority and add no
    mutation.
55. `GOV-UX-01B18A`: add the HTTP-disabled bounded Explain conversation-scope
    handle catalog over consistent stored traces; keep all Explain routes absent.
56. `GOV-UX-01B18B`: expose only the trace-backed Explain conversation catalog
    through authenticated read-only `/explain/scopes`; keep Explain data absent.
57. `GOV-UX-01B18C`: add the fixed bounded exact-conversation Explain turn page
    behind the shared query service; omit raw identifiers and keep HTTP data
    routes absent.
58. `GOV-UX-01B18D`: expose only that page through exact-scope read-only
    `/explain/turns`; preserve purpose isolation and keep Explain detail,
    resource, rebuild, and mutation routes absent.
59. `GOV-UX-01B19A`: add the HTTP-disabled bounded exact-conversation Explain-
    turn resource-handle page; preserve B18C parity and keep application/
    registry wiring plus Explain detail routes absent.
60. `GOV-UX-01B19B`: wire the existing `/explain/turns` route to B19A through
    current-session Explain-read `explain_turn` bindings; keep Explain detail,
    rebuild, and mutation routes absent.
61. `GOV-UX-01B19C`: add the HTTP-disabled bounded exact-conversation Explain-
    turn detail projection; prove scope before secondary reads, omit raw
    identifiers and payloads, and keep resource resolution and routes absent.
62. `GOV-UX-01B19D`: expose B19C through one read-only Explain-turn resource
    route; require exact current-session scope and `explain_turn` authority,
    map a resolved missing detail to fixed `404`, and add no rebuild or mutation.
63. `GOV-UX-01B20A`: add the HTTP-disabled exact-scope Memory-record forget
    preview with fixed deletion/retrieval/restore evidence; keep handles, routes,
    confirmation, service calls, and durable mutation absent.
64. `GOV-UX-01B20B`: expose only B20A through the existing current-session
    Memory resource authority and single-use preview registry; require exact
    Origin/CSRF/body and keep confirmation or mutation absent.
65. `GOV-UX-01B20C`: add an HTTP-disabled expected-snapshot overload to the
    shared local-admin forget operation; enforce exact scope/state/latest-
    revision freshness inside its immediate deletion transaction while
    preserving CLI/QQ behavior.
66. `GOV-UX-01B20D`: consume the exact single-use Memory forget preview,
    recompute its digest-bound snapshot, and invoke only the shared atomic
    forget operation through one CSRF-protected confirmation route.
67. `GOV-UX-01B21A`: add the HTTP-disabled shared expected-snapshot Memory
    restore operation and delegate both existing CLI aliases through its legacy
    call while keeping all restore previews and routes absent.
68. `GOV-UX-01B21B`: add the HTTP-disabled exact-scope Memory-record restore
    preview with fixed retrieval and separately confirmed forget evidence; keep
    handles, routes, confirmation, service calls, and durable mutation absent.
69. `GOV-UX-01B21C`: expose only B21B through the existing current-session
    Memory resource authority and single-use preview registry; preserve forget
    behavior and keep restore confirmation or mutation absent.
70. `GOV-UX-01B21D`: consume exact single-use Memory restore authority,
    recompute its digest-bound snapshot, and invoke only the shared atomic
    restore operation through the existing CSRF-protected confirmation route.
71. `GOV-UX-01B22B`: add the HTTP-disabled exact-user Privacy preference-change
    preview; treat absence as effective opt-in, return fixed version/effect/
    rollback evidence, and keep authority, routes, confirmation, and writes
    absent.
72. `GOV-UX-01B22C`: expose only B22B through the existing exact-user Privacy
    scope and single-use preview registry; keep confirmation, consumption,
    service calls, writes, and enforcement changes absent.
73. `GOV-UX-01B22D`: add an HTTP-disabled atomic expected-snapshot overload to
    the shared Privacy mutation; distinguish implicit default from stored state,
    preserve legacy CLI behavior, and keep confirmation and HTTP writes absent.
74. `GOV-UX-01B22E`: consume exact single-use Privacy change authority,
    recompute its digest-bound snapshot, and invoke only B22D through a separate
    CSRF-protected confirmation route.
75. `GOV-UX-01B23A`: extract the read-only `ops:doctor` inspection into a typed
    Operations owner and delegate the CLI without changing its JSON, redaction,
    exit status, or write boundary; keep HTTP and browser behavior absent.
76. `GOV-UX-01B23B`: add the HTTP-disabled governance Operations coordinator
    over the shared doctor; return only a fixed path-free status DTO with backup
    availability and a `stopped_service_only` restore boundary, and execute no
    maintenance action.
77. `GOV-UX-01B23C`: add HTTP-disabled verified backup creation through the
    existing SQLite owner; return only fixed path-free artifact evidence and a
    stopped-service restore handoff.
78. `GOV-UX-01B23D`: expose the fixed Operations status through one
    authenticated-unscoped read-only route; keep backup creation and all
    Operations mutations unwired.
79. `GOV-UX-01B23E`: add the fixed HTTP-disabled verified-backup preview;
    expose no destination, authority, route, or file mutation.
80. `GOV-UX-01B23F`: expose only the verified-backup preview through the
    authenticated-unscoped mutation boundary and issue fixed session-bound
    authority; keep destination allocation, confirmation, and B23C unwired.
81. `GOV-UX-01B23G`: add an HTTP-disabled no-input server-owned backup adapter
    with a fixed private directory and opaque reference; keep confirmation and
    every route unchanged.
82. `GOV-UX-01B23H`: consume the exact single-use verified-backup authority,
    recompute its fixed preview, and invoke only the no-input server-owned backup
    adapter through one authenticated-unscoped confirmation route.
83. `GOV-UX-01B23I`: add an HTTP-disabled exact-reference managed-backup
    restore-handoff preview with stable private-artifact validation and no path,
    catalog, route, or in-process restore behavior.
84. `GOV-UX-01B23J`: expose only the exact-reference restore-handoff preview
    through authenticated-unscoped mutation access and issue fixed session-bound
    authority; keep confirmation and every restore effect absent.
85. `GOV-UX-01B23K`: consume only exact current-session restore-handoff
    authority and recompute the referenced preview; keep restore execution and
    lifecycle control absent.
86. `GOV-UX-01B23L`: add the HTTP-disabled fixed private pending-envelope owner
    with no-clobber durability and fixed path-free evidence; keep B23K, restore,
    and service lifecycle behavior unchanged.
87. `GOV-UX-01B23M`: add the HTTP-disabled read-only reopen/validation owner for
    the fixed pending envelope; keep consumption and restore execution absent.
88. `GOV-UX-01B23N`: wire the exact B23K confirmation to the B23L publisher after
    digest equality; return fixed path-free receipt evidence and keep B23M,
    restore execution, and service lifecycle control absent.
89. `GOV-UX-01B23O`: add the independent HTTP-disabled stopped-service consumer;
    reuse strict B23M validation and B23I artifact evidence, require explicit
    stop proof, claim durably, delegate only to the atomic restore owner, and
    bound crash recovery without adding route or lifecycle wiring.
90. `GOV-UX-01B24A`: add the HTTP-disabled fixed exact-group summary-policy
    status projection and delegate CLI status without changing mutation or
    output behavior.
91. `GOV-UX-01B24B`: add the HTTP-disabled bounded exact-group summary-policy
    scope catalog with purpose-specific handle issuance and no route wiring.
92. `GOV-UX-01B24C`: expose only that catalog through authenticated read-only
    `/group-summary/scopes`, binding exact groups to the future status purpose.
93. `GOV-UX-01B24D`: expose only the fixed B24A status projection through exact-
    scope read-only `/group-summary/policy`; keep every mutation route absent.
94. `GOV-UX-01B24E`: add the HTTP-disabled write-free exact-group summary-
    policy change preview and digest; keep mutation authority and routes absent.
95. `GOV-UX-01B24F`: add the HTTP-disabled atomic expected-snapshot overload to
    the shared group-summary-policy mutation; distinguish implicit default from
    stored state and preserve legacy CLI/QQ/repository behavior.
96. `GOV-UX-01B24G`: expose only the B24E preview through scoped CSRF-protected
    `/group-summary/policy` POST and issue current-session change authority.
97. `GOV-UX-01B24H`: consume that authority once through separate scoped
    `/group-summary/policy/confirm`, recompute B24E, and invoke only atomic B24F.
98. `GOV-UX-01B25A`: move local-admin display-profile redaction behind the typed
    shared governance service and delegate CLI behavior unchanged.
99. `GOV-UX-01B25B`: move local-admin platform-account unlink behind the typed
    shared governance service and delegate CLI behavior unchanged.
100. `GOV-UX-01C1`: serve the dependency-free browser login/session shell and
    read-only aggregate Overview over the existing hardened APIs.
101. `GOV-UX-01C2`: add the read-only browser Model invocations Activity view
    over the existing authenticated-unscoped payload-free aggregate.
102. `GOV-UX-01C3`: add the read-only browser Tool calls Activity view over the
    existing authenticated-unscoped bounded payload-free list and establish the
    responsive accessible list pattern.
103. `GOV-UX-01C4`: add the read-only browser Worker heartbeats Activity view
    over the existing authenticated-unscoped bounded details-free list.
104. `GOV-UX-01C5B`: add the read-only browser Jobs Activity view over the
    existing authenticated-unscoped bounded payload-free list.
105. `GOV-UX-01B26A`: add the HTTP-disabled bounded display-profile exact-user
    catalog and future purpose-specific scope-handle issuance.
106. `GOV-UX-01B26B`: add the HTTP-disabled exact-user identifier-free
    display-profile target page.
107. `GOV-UX-01B26C`: add the HTTP-disabled target resource-handle page over
    only B26B-selected targets.
108. `GOV-UX-01B26D`: expose only the B26A catalog through authenticated read-
    only `/display-profile/scopes`, binding exact users to the future target-
    read purpose.
109. `GOV-UX-01B26E`: expose only the B26C page through exact-user scoped read-
    only `/display-profile/targets`, binding target resources to current-session
    authority while leaving dynamic target routes absent.
110. `GOV-UX-01B26F`: add the HTTP-disabled exact-target display-profile detail
    projection over only B26B-selected targets and B26C's full target-ID domain.
111. `GOV-UX-01B26G`: expose only B26F through exact-user scoped read-only
    `/display-profile/targets/:resourceHandle`, resolving current-session
    target authority before the bounded detail read.
112. `GOV-UX-01B26H`: add the HTTP-disabled exact-target display-profile
    redaction preview with exact affected counts, an opaque full-row snapshot,
    irreversible rollback semantics, and no mutation authority.
113. `GOV-UX-01B26I`: add the HTTP-disabled atomic expected-snapshot overload
    for exact-target display-profile redaction while preserving B25A callers.
114. Completed locally: expose every existing browser-safe governed operation,
    including rollback, expiration, record forget/restore, Privacy, Group-
    summary, Display-profile, platform-account unlink, verified backup, and
    restore-handoff, while preserving each independent authority boundary.
115. Retention remains a backend prerequisite until a fixed policy, snapshot,
    audit, preview/confirmation, and irreversible/rollback contract exists; do
    not infer that contract in browser code.
116. Run live Provider/QQ, deployment/restart, stopped-service restore, soak,
    screenshot, and production accessibility acceptance only after fresh
    explicit authorization.

The A1 fail-first suite must cover at least:

- disabled/no-listener configuration and loopback-only validation;
- missing, wrong, oversized, and valid login credentials without credential
  reflection;
- missing, malformed, unknown, expired, logged-out, and cross-session cookies;
- missing/wrong `Origin`, missing/wrong CSRF, and CSRF reuse from another
  session on every mutation method;
- side-effect-free authenticated `GET` without a CSRF requirement;
- malformed, wildcard, empty, cross-session, cross-purpose, and mismatched
  scope handles before the authorized handler;
- ignored QQ/forwarded role and address headers;
- body limit, receive timeout, fixed errors, security headers, session capacity,
  expiry, and restart invalidation;
- zero governance callback, database, audit, and domain mutation on every
  negative path.

P8 completion additionally requires CLI/QQ/UI policy parity, synthetic database
and FK assertions, keyboard/focus checks, WCAG AA contrast, no horizontal scroll
at 375px, stable desktop layout at 1440px, reduced-motion behavior, and browser
screenshots containing synthetic data only.
