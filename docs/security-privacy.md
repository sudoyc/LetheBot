# Security and Privacy

LetheBot is local-first and memory-heavy, so privacy rules must be part of the architecture rather than a later feature.

## Principles

- Users must be able to inspect long-term memory.
- Users must be able to delete memory.
- Durable memory must include source metadata.
- Platform identifiers are operational identity data. They may be used in local prompts when needed for identity disambiguation, platform operations, user-requested ID handling, permissions, or debug, but should be purpose-bound, minimal, and structured.
- Secrets must never be committed or stored as ordinary memory/audit content.
- Deletion and disable operations must affect retrieval immediately.

## Reverse HTTP Ingress Trust

- The application listener defaults to `127.0.0.1`.
- The reverse HTTP event route is enabled by `ONEBOT_TRANSPORT=http`. WebSocket
  mode does not expose it unless `LETHEBOT_REVERSE_HTTP_ENABLED=true`; the
  explicit flag accepts only literal `true` or `false`.
- When the route is enabled, a non-loopback `LETHEBOT_HOST` requires a non-empty
  `ONEBOT_TOKEN`; invalid configuration fails before adapter startup or
  `listen()`. A WS-only listener may bind non-loopback without an ingress token
  because `POST /onebot/event` returns `404` and never enters admission.
- Tokenless enabled reverse HTTP development is limited to literal `127.0.0.1`
  or `::1` binds.
- Reverse HTTP bodies are capped by both declared `Content-Length` and streamed
  raw bytes. `LETHEBOT_MAX_EVENT_BODY_BYTES` defaults to `262144`, and
  `LETHEBOT_EVENT_BODY_TIMEOUT_MS` defaults to `5000`; both require positive
  integers. Limit, timeout, abort, and request-error paths terminate once and do
  not parse or admit partial events.
- With a configured token, a valid Bearer header can be authenticated from the
  headers. Missing or malformed Bearer/signature candidates receive `401` before
  body buffering; a syntactically valid SnowLuma HMAC candidate is verified only
  against the completed bounded raw body. Rejected requests create no raw event,
  chat, turn, action, or governance effect.

## Local Governance HTTP Trust

- Governance HTTP uses a dedicated listener controlled by
  `LETHEBOT_GOVERNANCE_ENABLED`; it is disabled by default and opens no port when
  disabled. Its host accepts only exact `127.0.0.1` or `::1` values.
- Enabling it requires a separate 32-512 UTF-8-byte, control-free admin token.
  QQ roles, forwarded identity/address headers, and loopback peer status do not
  authenticate an HTTP administrator.
- The listener uses absolute in-memory sessions, session-bound CSRF, exact
  origin checks, bounded bodies, and fixed diagnostic-free failures. Session
  cookie digests are the only retained session identifiers; restart invalidates
  every session.
- Governance and application ports must differ when enabled. Startup failure on
  either listener closes both, and normal application shutdown closes both.
- Configured retention preview-confirm is system-scoped and uses the same
  authenticated session, exact Origin, CSRF, bounded JSON, and `no-store`
  boundary. Preview and confirmation expose aggregate policy/effects only;
  candidate IDs, SQL, paths, opaque handles, and digests stay out of DOM,
  storage, logs, and announcements. Confirmation consumes the single-use
  authority before dispatch and recomputes the server-owned timestamp/state in
  one SQLite `IMMEDIATE` transaction. Audit insertion failure rolls back all
  deletion; replay and drift are conflicts. A backup is recommended for the
  irreversible hard-delete boundary, not required by the program.

## Retention Privacy Boundary

Retention defaults are raw/chat/event-processing failures 90 days, audit 365
days, and rejected/disabled/deleted memory 90 days; `0` means forever. Active
memory is never selected for retention hard purge. The shared planner respects
provenance, job, turn, admission, Attention, summary, and model-invocation pins
and returns only bounded aggregate projections to governance clients.
- The current production wiring supplies authenticated-unscoped
  `GET /governance/api/v1/activity/model-invocations`,
  `GET /governance/api/v1/activity/tool-calls`,
  `GET /governance/api/v1/activity/action-decisions`,
  `GET /governance/api/v1/activity/action-executions`,
  `GET /governance/api/v1/activity/jobs`,
  `GET /governance/api/v1/activity/job-attempts`,
  `GET /governance/api/v1/activity/worker-heartbeats`,
  `GET /governance/api/v1/activity/event-processing-failures`, and
  `GET /governance/api/v1/activity/audit`, plus purpose-specific
  `GET /governance/api/v1/memory/scopes` and
  `GET /governance/api/v1/privacy/scopes`, and
  `GET /governance/api/v1/group-summary/scopes`, and
  `GET /governance/api/v1/explain/scopes`, through the shared governance query
  service. These authenticated-unscoped routes reject query strings and scope
  headers. Memory discovery returns only bounded fixed labels/fingerprints and
  opaque exact-scope handles bound to the authenticated session, expiry, and
  `governance.memory.records.read`. Exact-scope
  `GET /governance/api/v1/memory/records` rejects query strings, requires that
  handle, and returns only the bounded identifier-free record page with hidden
  restricted text. Each returned record handle is independently bound to the
  current session, expiry, `governance.memory.records.read`, resource kind
  `memory_record`, and the resolved exact scope. Read-only
  `GET /governance/api/v1/memory/records/<resource-handle>` requires that same
  scope authority, resolves the resource against all five bindings, and returns
  only the fixed bounded redacted provenance detail. Mutation-marked `POST` at
  the same resource path additionally requires exact Origin/CSRF and exact body
  `{ "action": "forget" }` or `{ "action": "restore" }`; it calls only the
  corresponding exact-scope write-free preview and issues a fresh single-use
  handle bound to the current lifecycle state, revision, digest, session,
  action, resource, and scope. Mutation-marked
  `POST /governance/api/v1/memory/records/<resource-handle>/confirm` accepts only
  exact `{ "confirm": true, "previewHandle": HANDLE }` for forget or that body
  plus exact `"action": "restore"` for restore. It consumes only matching
  current-session action/resource/scope authority once, recomputes the
  corresponding exact-scope preview, and calls only the shared atomic expected-
  snapshot forget or restore operation. Unknown authority is concealed, stale
  or reused authority conflicts, and success returns bounded identifier-free
  lifecycle/revision/audit/retrieval and rollback evidence. The
  Privacy discovery read returns the corresponding exact-
  user handles bound to
  `governance.privacy.preferences.read`. Exact-scope
  `GET /governance/api/v1/privacy/preferences` rejects query strings, requires
  that handle, and returns only the bounded owner-identifier-free preference
  page. Mutation-marked `POST` at the same path additionally requires exact
  Origin/CSRF and exact `{ "action": "change", "preferenceType": TYPE,
  "targetState": STATE }`. It calls only the fixed write-free change preview and
  issues a fresh handle bound to the current session, action
  `privacy.preference.change`, resource kind `privacy_preference`, preference
  type, exact scope, current effective state, positive stored-timestamp-or-
  default version, and digest. Missing/no-op state is concealed. A separate
  CSRF-protected `POST /governance/api/v1/privacy/preferences/confirm` accepts
  only exact `{ "confirm": true, "previewHandle": HANDLE,
  "preferenceType": TYPE, "targetState": STATE }`. It consumes only matching
  current-session `privacy.preference.change` authority once, recomputes the
  digest-bound snapshot, and invokes only the shared atomic expected-snapshot
  mutation. Unknown authority is concealed; reused, drifted, or stale authority
  conflicts. Success exposes only fixed state/version, audit, immediate-
  enforcement, and rollback evidence. Group-summary discovery exposes no raw
  group or policy data; its exact-group handles are session/expiry-bound to
  `governance.group_summary_policy.status.read`. Exact-scope read-only
  `GET /governance/api/v1/group-summary/policy` rejects query strings, requires
  that handle, passes only the resolved group scope to the fixed status
  projection, and returns effective state plus bounded stored-policy evidence
  without raw identifiers. Mutation-marked `POST` at the same path additionally
  requires exact Origin/CSRF and an exact fixed target-state body, delegates only
  to the write-free preview, and returns fresh current-session
  `group.summary_policy.change` authority bound to the exact scope, current
  state/generation evidence, and digest. Separate CSRF-protected
  `POST /governance/api/v1/group-summary/policy/confirm` accepts only the fixed
  confirmation body, consumes matching session/action/resource/scope authority
  once, recomputes state, generation, and digest, and invokes only the atomic
  expected-snapshot mutation. Unknown authority is concealed; reuse, drift,
  no-op, or stale evidence conflicts. Success exposes only fixed stored-policy,
  enforcement, audit, cancellation, and rollback evidence without group, actor,
  reason, job, audit, session, or preview identifiers.
  Display-profile discovery exposes no canonical-user, platform, group, profile,
  nickname-history, session, or secret values. Authenticated
  `GET /governance/api/v1/display-profile/scopes` rejects queries and scope
  headers before catalog work and binds each exact-user handle to the current
  session, expiry, and `governance.display_profile.targets.read`. Exact-scope
  `GET /governance/api/v1/display-profile/targets` rejects queries and requires
  one such handle, then exposes only the unchanged bounded identifier-free target
  page. Each target handle is bound to the current session and expiry, the same
  purpose, resource kind `display_profile_target`, the full internal target ID,
  and the resolved exact user scope. Read-only
  `GET /governance/api/v1/display-profile/targets/<resource-handle>` requires
  that same scope authority and resolves the resource against the current
  session, purpose, kind, and exact scope before returning the bounded redacted
  shared detail. Missing detail is concealed as `404`. Mutation-marked `POST`
  at the same path additionally requires exact Origin/CSRF and body
  `{ "action": "redact" }`, returns only the identifier-free full-row preview
  plus an opaque current-session action handle, and binds its snapshot
  fingerprint, total affected rows, and digest without consuming authority or
  mutating durable state. Separate mutation-marked `POST` at that resource path
  plus `/confirm` accepts only the fixed confirmation body, consumes matching
  session/action/resource/scope authority once, recomputes all three preview
  bindings, resolves only the trusted internal mutation selectors, and invokes
  only the atomic expected-snapshot redaction. Unknown authority is concealed;
  reuse, drift, or stale evidence conflicts. Success exposes only identifier-
  free affected counts, redaction time, effects, fixed redacted audit evidence,
  and the irreversible rollback boundary.
  Platform-account unlink preview uses mutation-marked authenticated-unscoped
  `POST /governance/api/v1/identity/platform-accounts/unlink`. The shared
  boundary rejects missing session, Origin/CSRF, exact JSON, query, or scope-
  header evidence before the preview owner. A valid request accepts the raw
  normalized selector only as bounded input and private session-owned resource
  binding; the response contains only the identifier-free preview and opaque
  resource/action handles. The action handle binds the same system scope and
  resource to the exact snapshot fingerprint, fixed one-row version, and
  digest. Confirmation uses a separate mutation-marked `/confirm` route with
  exact opaque resource and preview handles. It resolves current-session
  purpose/kind/system authority and validates the canonical private selector
  before consuming action authority, then recomputes every bound preview field
  and invokes only the atomic expected-snapshot unlink with a fixed redacted
  reason. Unknown authority is concealed; replay, drift, or stale mutation
  evidence conflicts. Neither response nor audit exposes the raw account or
  canonical-user identifier; success returns only bounded fingerprint, disable,
  effect, audit, and unsupported-relink evidence.
  Explain discovery exposes no conversation or group IDs; its exact-scope
  handles are session/expiry-bound to `governance.explain.turns.read`.
  Exact-scope `GET /governance/api/v1/explain/turns` rejects query strings,
  requires that handle, and returns only the fixed bounded identifier-free turn
  page. Each turn handle is independently bound to the current session, expiry,
  `governance.explain.turns.read`, resource kind `explain_turn`, and the resolved
  exact scope. Read-only
  `GET /governance/api/v1/explain/turns/<resource-handle>` requires that same
  scope authority, resolves the resource against all five bindings, and returns
  only the fixed bounded identifier-free context/decision/execution/tool detail.
  ContextBuilder rebuild and Explain mutation routes remain absent.
  The model read contains no raw invocation
  IDs, prompts, responses, or provider payloads. The tool read uses the bounded default list with input and
  output absent. The action-decision read uses the bounded default list with action
  plans absent. The action-execution read uses the bounded default list with
  audit entries absent. The job read uses the bounded default list with payload
  and result absent. The job-attempt read uses the bounded default list with
  result absent. The worker read uses the bounded default list with details
  absent. The event-processing-failure read uses the bounded default list with
  details absent and retains only its fixed hash evidence. The audit read uses
  the bounded default list with details absent and the details-redacted/redacted
  signals set. Operational identifiers, classifications, reasons, suppressors,
  summaries, and diagnostics use the shared redaction boundary. None adds a
  direct repository/SQL path. C1 serves only fixed sessionless same-origin HTML,
  CSS, and JavaScript at the four exact `/governance` browser paths. Static
  dispatch creates no session or callback effect, accepts no query or non-GET
  variant, and returns the existing no-store/referrer/nosniff/CSP headers. The
  module calls the existing session and Overview APIs plus the exact
  authenticated-unscoped model-invocation aggregate, bounded tool-call list,
  bounded details-free worker-heartbeat list, bounded payload-free job list, and
  bounded result-free job-attempt list, plus the bounded actions-free action-
  decision list, bounded audit-entry-free action-execution list, and bounded
  details-free hash-backed event-processing-failure list.
  Each Activity request carries no query, body, scope header, CSRF value, or new
  authority. C2 inserts only
  predeclared model aggregate fields as text. C3 strictly validates at most 100
  exact B14D records before safe DOM row creation, renders only bounded tool/
  requester, actor/context, outcome/diagnostic/redaction, duration, and
  recorded-time fields, and omits call, turn, canonical-user, input, and output
  values from the page. C4 applies the same strict bound and safe row creation
  to exact B14B worker/type, fixed-status, optional current-job, and heartbeat-
  time fields; unknown fields and worker details fail closed. C5B strictly
  validates at most 100 exact B14C job records before rendering bounded
  job/type/status, attempt, schedule/update, and optional lease/run/error fields
  as text. Unknown keys, payload, result, malformed strings/numbers/dates, and
  oversized arrays fail closed before row replacement. C5C shares only the
  repeated lifecycle machinery for those three lists: each fixed configuration
  retains its exact endpoint closure, strict renderer, DOM bindings, messages,
  and isolated request sequence. Switching tabs or views still invalidates only
  stale authority-free reads, and `401` still clears in-memory session state;
  no endpoint, accepted field, dynamic selector, or rendering sink is widened.
  C5E shares only fixed JavaScript primitives for the explicit key/ID bindings,
  accepted enum presentation, required/optional bounded text and date checks,
  record cells/statuses, and bounded normalized lists. Separate exact-key
  validators and named renderers retain the same accepted records, hidden
  fields, DOM text/classes/order, and fail-closed outcomes; HTML, CSS, requests,
  session state, and authority remain unchanged.
  C5D adds only an explicit fifth controller configuration and strict B14G
  validator/renderer. It accepts at most 100 exact attempt records, validates
  but projects away the attempt ID, rejects result and unknown fields, and
  renders only redacted job/attempt, worker, status/error, and timeline values
  through the shared safe DOM primitives. The request remains an authority-free
  exact same-origin default GET; stale cancellation, session expiry, and the
  existing responsive/keyboard states are unchanged.
  C6A adds only an explicit sixth controller configuration and strict B14E
  validator/renderer. It accepts at most 100 exact decision records, validates
  but projects away the turn ID, rejects actions, unknown keys, malformed fields,
  unbounded reason/suppressor values, and oversized arrays, and renders only the
  redacted decision reference, actor/risk, confidence, evaluator state, action
  count, bounded reasons/suppressors, and decision time through the shared safe
  DOM primitives. The request remains an authority-free exact same-origin
  default GET; stale cancellation, session expiry, and the existing responsive/
  keyboard states are unchanged.
  C6B changes only how the five non-model list shells are represented. A fixed
  local definition table constructs their exact tabs and panels with
  `document.createElement`, fixed attributes, and `textContent` before controller
  binding. It introduces no parser, `innerHTML`, dynamic code, request, asset,
  lazy load, compression, minification, dependency, accepted field, rendering
  sink, or authority. Exact runtime DOM, text, order, ARIA/hidden/busy states,
  validation, session expiry, stale cancellation, keyboard/focus, and responsive
  behavior remain unchanged; the fixed bundle is 60,435 bytes and remains under
  both the 60,500-byte prerequisite and permanent 65,536-byte boundary.
  C6C adds only the seventh fixed controller definition and a strict B14F
  validator/renderer. It accepts at most 100 exact execution records with fixed
  action/status/audit domains, bounded redacted references and diagnostics, and
  canonical execution time. Unknown keys, `auditEntry`, nested or malformed
  values, and oversized arrays fail closed before row replacement. Only
  execution/decision references, action/status, optional effect references,
  downgrade/error evidence, audit level, and time enter safe text nodes. The
  request remains the exact same-origin default GET with no query, body, scope,
  CSRF, or authority change. The fixed bundle is 63,300 bytes and stays below
  65,536 without a new asset, backend path, or dependency.
  C7A adds only the eighth fixed controller definition and a strict B14H
  validator/renderer. It accepts at most 100 exact failure records with bounded
  redacted identifiers/stage/error name, canonical occurrence time, fixed
  lowercase 64-hex error evidence, and bounded optional references,
  conversation type, and hashes. Unknown keys, `details`, nested or malformed
  values, and oversized arrays fail closed before row replacement. Only the
  failure/time, optional raw-event/turn references, stage/conversation type,
  error name, and fixed hashes enter safe text nodes. The request remains the
  exact same-origin default GET with no query, body, scope, CSRF, or authority
  change. The fixed bundle is 65,498 bytes and stays below 65,536 without new
  CSS, an asset, backend path, or dependency.
  C7B changes representation only. Identical tool/worker/job record/text bounds
  and repeated safe row-line class values become fixed shared constants, while
  JavaScript-only compaction removes line terminators only next to fixed opening
  or closing delimiters, commas, and semicolons. HTML/CSS bytes, JavaScript
  tokens and behavior, endpoints, accepted payloads, DOM/text/classes/order,
  session/stale-request handling, keyboard/focus, and responsive output remain
  exact. The fixed bundle is 63,279 bytes, below the 63,300-byte Audit
  prerequisite and 65,536-byte permanent boundary, without token renaming,
  parser/evaluation, another asset, backend path, authority, or dependency.
  C7C adds only the ninth fixed controller definition and a strict B14I
  validator/renderer. It accepts at most 100 exact Audit records with bounded
  event/category/level/summary fields, canonical time, an exact optional-field
  actor object, required redaction booleans, and bounded optional risk/evaluator
  evidence. Unknown keys, `details`, nested or malformed values, and oversized
  arrays fail closed before row replacement. Only already-redacted event/time,
  actor, summary/risk/evaluator, and explicit hidden/redacted signals enter safe
  text nodes. The request remains the exact same-origin default GET with no
  query, body, scope, CSRF, or authority change. The fixed bundle is 65,269
  bytes and stays below 65,536 without new CSS, an asset, backend path, or
  dependency.
  C8A changes JavaScript ownership only. The fixed shell statically imports one
  same-origin `activity.js` module containing the exact Activity endpoint
  definitions, strict schemas/normalizers, and safe renderers. Authentication,
  CSRF/session state, request transport, controller sequencing, stale-response
  cancellation, and listeners remain in `app.js`; HTML/CSS and runtime DOM are
  byte-identical. The 8,641/14,850/18,380-byte HTML/CSS/shell plus the
  23,616-byte module total 65,487 bytes. Each asset, the 41,871-byte shell, and
  the aggregate stay below 65,536. The static module request issues no API
  authority and adds no dynamic code, external asset, backend path, scope,
  mutation, build step, package, or dependency.
  C8B adds a separate static same-origin `memory.js` module over only the
  existing purpose-isolated Memory reads. Scope discovery sends no scope header;
  records remain closed until explicit selection and then receive exactly one
  validated current-session handle through `X-LetheBot-Scope`. Catalog and page
  responses fail closed on unknown keys, malformed/duplicate/oversized entries,
  invalid domains, inconsistent restricted-text signals, or noncanonical dates
  before prior rows are replaced. Opaque scope and resource handles remain only
  in JavaScript memory: option values use local indexes, and no handle enters
  DOM text/attributes, web storage, logs, or visible errors. The module exposes
  no resource detail, preview, confirmation, mutation, raw selector, caller
  limit, or cross-purpose maintenance authority.
  Final HTML/CSS/shell/Activity/Memory assets are
  8,641/16,415/20,939/23,616/16,720 bytes. The shell is 45,995 bytes and every
  asset remains below 65,536; independent feature modules are checked per asset
  instead of as one aggregate transfer.
  C8C adds only the purpose-isolated read-only Review queue. Review scope
  discovery sends no scope header, and `/memory-reviews` receives only the
  selected Review catalog handle. Records and Review use separate in-memory
  catalogs, fingerprints, handles, and request sequences; neither authority is
  inferred from or reused by the other. Exact schemas reject unknown,
  duplicate, malformed, oversized, noncanonical, inconsistent-scope, and
  invalid lifecycle/revision payloads before prior rows are replaced. Only
  bounded proposal classifications/evidence, dates, and resource-handle expiry
  enter text nodes. Opaque handles remain absent from DOM text/attributes,
  storage, logs, and errors, and no detail or mutation control exists. Final
  HTML/CSS/shell/Activity/Memory assets are
  8,641/16,918/24,328/23,616/31,215 bytes; the shell is 49,887 bytes and every
  asset remains below 65,536.
  C8D adds only exact-scope row-selected Review detail. A local row index maps to
  the current in-memory resource handle; exact GET
  `/memory-reviews/:resourceHandle` carries only the current Review scope handle
  in `X-LetheBot-Scope`. Query, body, Origin, CSRF, raw selector, cross-purpose
  authority, and non-GET requests are absent. Scope, subview, navigation,
  refresh, expiry, and logout changes increment the independent detail sequence
  and clear authority. Refresh can retain only the proposal reference until the
  new list supplies replacement scope/resource handles.
  The exact DTO validator bounds candidate and revision arrays at 32, rejects
  unknown/malformed/duplicate/inconsistent values, and requires all summary
  fields to match the selected current row before replacing content. Fixed
  malformed, unavailable, not-found, and changed states preserve the last valid
  nodes without exposing opaque authority. Rendering uses only bounded redacted
  references, fingerprints/counts, classifications, transitions, actor/context,
  reason, and canonical dates through safe text nodes. No preview, confirmation,
  mutation, raw identifier, unrestricted field, CSS, backend route, or
  dependency is added. Final HTML/CSS/shell/Activity/Memory assets are
  8,641/16,918/24,227/23,616/50,900 bytes; the shell is 49,786 bytes and every
  asset remains below 65,536.
  C8E adds only exact-scope row-selected Record provenance. A local row index
  resolves the current in-memory `memory_record` handle; exact GET
  `/memory/records/:resourceHandle` carries only the current Records scope handle
  in `X-LetheBot-Scope`. Query, body, Origin, CSRF, raw selector, Review-purpose
  authority, and non-GET requests are absent. Scope, Review entry, navigation,
  refresh, expiry, and logout changes invalidate the independent detail sequence;
  refresh retains only a record reference until a replacement row supplies fresh
  authority.
  The exact DTO validator requires complete list/detail record coherence and
  bounds source, revision, and audit arrays at 32. Unknown keys, malformed or
  duplicate references/numbers, invalid classifications, inconsistent counts or
  truncation, noncanonical or misordered dates, bad redaction signals, row drift,
  and visible audit details fail closed without replacing prior valid evidence.
  Rendering uses only bounded redacted record/provenance fields and explicit
  hidden/redacted/evaluator signals through safe text nodes. Handles remain
  absent from DOM, storage, logs, and announcements. No forget, restore, preview,
  confirmation, mutation, raw identifier, CSS, backend route, or dependency is
  added. Final HTML/CSS/shell/Activity/Memory assets are
  8,641/16,918/24,227/23,616/64,978 bytes; the shell remains 49,786 bytes and
  every asset remains below 65,536.
  C8F changes representation ownership only. Exact static same-origin
  `memory-presentation.js` owns the fixed Memory/Review schemas, validation,
  coherence checks, safe DOM helpers, formatting, and rendering; `memory.js`
  retains every endpoint, transport/controller transition, scope/resource
  handle, request sequence, cancellation path, listener, and session-injected
  callback. The presentation route creates no session, scope, resource,
  preview, CSRF, or domain authority and imports no controller. Handles remain
  absent from DOM, text, attributes, storage, logs, and announcements. HTML,
  CSS, `app.js`, and `activity.js` remain byte-identical; controller and
  presentation bodies are 32,442/33,072 bytes, both below 35,000. No endpoint,
  accepted field, request, sink, preview, confirmation, mutation, backend, CSS,
  package, dependency, or build boundary is widened.
  C8G adds only the write-free pending-review approval preview. The shell keeps
  CSRF private and injects a narrow same-origin POST transport; the controller
  contributes only the current Review scope handle, current list-issued
  resource path, and exact approval body. Browser `Origin`, JSON content type,
  session CSRF, and Review-purpose scope are therefore required without exposing
  the token to presentation code or reusing Records authority.
  The presentation module validates the exact B7C schema, fixed effect arrays,
  safe counts/revisions/expiry, and complete catalog/row/detail/preview
  coherence. It reconstructs only bounded display evidence and drops the opaque
  preview handle and digest immediately. Those values never enter controller
  state, DOM text or attributes, storage, logs, or announcements. Independent
  request sequencing, disabled duplicate commands, expiry timers, and scope,
  selection, refresh, tab, navigation, session, and logout invalidation suppress
  stale authority. Confirmation, handle consumption, review transition, memory
  application, rollback, backend changes, and durable writes remain absent.
  C8H adds only explicit approval confirmation over existing B7D. After the
  exact C8G response passes presentation validation, the controller retains one
  private transient authority containing the opaque preview handle, expiry, and
  current Review selection binding; it still discards the digest. The authority
  is absent from presentation values and the exported feature surface, and the
  handle remains absent from DOM text/attributes, storage, logs, and
  announcements. `Confirm approval` cannot enable for missing, expired,
  submitted, or noncurrent authority.
  Confirmation clears authority before using the current list-issued Review
  resource path, current Review scope, and shell-held CSRF in exact same-origin
  `POST /memory-reviews/:resourceHandle/confirm` with only
  `{ "confirm": true, "previewHandle": HANDLE }`. The exact B7D result must
  remain coherent with the selected row/detail/preview and contain only approved
  state at the next revision, bounded approve revision/audit references, false
  memory-record mutation, and the fixed unsupported rollback boundary. Unknown
  or drifted fields fail closed. Every malformed, unavailable, not-found, or
  conflict result requires a fresh preview; success invalidates selected
  authority and refreshes Review while preserving only bounded result evidence.
  Separate sequencing suppresses late confirmation responses, and all C8G
  scope, selection, refresh, subview, navigation, expiry, session, and logout
  boundaries clear authority. Rejection, expiration, application, rollback,
  memory-record mutation, backend, and persistence behavior remain unchanged.
  C8I adds only the B8A-backed write-free rejection preview. The controller
  derives the path from the current list-issued Review resource handle and sends
  only `{ "action": "reject" }` with current Review scope through the shell-held
  same-origin CSRF transport. It never derives authority from displayed proposal
  evidence or Records state. Starting rejection preview clears any private
  approval-confirmation authority before the request; a later fresh approval
  preview must re-establish that authority.
  The presentation module requires exact rejection action, safe current/next
  revision, rejected lifecycle, fixed transition/revision/audit effects,
  unavailable memory-record mutation, rejection-specific rollback boundary,
  future expiry, and complete scope/row/detail coherence. Unknown or drifted
  fields fail closed. The validated rejection handle and digest are immediately
  discarded and never enter controller state, exported feature state, DOM text
  or attributes, web storage, logs, or announcements. Independent sequencing,
  duplicate disabling, expiry, and scope/resource/selection/refresh/subview/
  navigation/session/logout invalidation suppress late authority. The seven
  explicit states render only bounded redacted evidence through safe DOM nodes.
  Final six assets are 8,641/16,918/24,428/23,616/53,035/46,484 bytes; the fixed
  shell remains 49,987 bytes and every asset remains below 65,536. No rejection
  confirmation, `/confirm` request, review transition, application, rollback,
  memory-record mutation, durable write, backend, or persistence behavior is
  added.
  C8J subsequently completes the rejection preview/confirmation pair through
  existing B8B without widening the trust boundary. A coherent unexpired C8I
  response yields one private transient rejection authority containing only the
  opaque preview handle, expiry, and current Review selection binding; the digest
  remains discarded, and the authority remains absent from presentation output,
  DOM text or attributes, web storage, logs, announcements, and exported feature
  state. `Confirm rejection` is disabled for missing, expired, submitted, or
  noncurrent authority and clears that authority before the exact same-origin
  CSRF-protected `/memory-reviews/:resourceHandle/confirm` request with
  `{ "confirm": true, "previewHandle": HANDLE, "action": "reject" }`. Strict B8B
  validation accepts only the coherent rejected outcome, next revision, fixed
  rejection transition/revision/audit evidence, false memory-record mutation,
  and `rejection_does_not_apply_memory_effects` boundary. Reuse, drift, malformed
  results, unavailable/not-found/conflict outcomes, expiry, scope/resource/
  selection refresh, navigation, session change, and logout expose no handle and
  require a fresh preview; only success refreshes Review. No memory application,
  rollback, direct database/service path, persistence-format, or deployment
  boundary is added.
  C9A adds only B9A's write-free application preview. For conflict proposals,
  the operator must choose one public `memoryRef` from the currently validated
  detail; the browser never receives or derives its raw memory ID. The exact
  request is scope/resource/CSRF/Origin bound and permits only `action: apply`
  plus that conflict-only reference. Strict normalization rejects unknown keys,
  role/count drift, selection mismatch, stale revisions, invalid consequences,
  and expiry. The preview handle remains private transient controller authority,
  its digest is discarded, and neither is rendered, stored, logged, announced,
  or exported. Any selection or authority drift invalidates it. C9A exposes no
  confirmation and therefore cannot apply, revise, audit, disable, or supersede
  a memory record.
  The browser clears the token input, keeps CSRF in module memory, and never
  reads cookies or web storage. Unregistered browser and governance domain
  routes remain `404`.
  The complete contract is in
  [`docs/governance-ui.md`](./governance-ui.md).

## Sensitive Data

Treat the following as sensitive or governed:

- Raw chat logs.
- User profiles and user memory.
- Group summaries and group memory.
- API keys, model credentials, cookies, private keys, and tokens.
- Tool outputs containing local paths, private files, personal data, or secrets.
- Audit logs and raw tool inputs/outputs.
- Event-processing failure diagnostics.
- Nickname/group-card history when it contains personal names, contact info, sensitive status, or other personal data.

QQ user IDs and group IDs are governed operational identity data. They are not equivalent to API secrets, but they should not be dumped into ordinary prompt context or public output unless the current task needs them.

Operator digests and worker outputs are also display/evidence boundaries.
`admin_digest` may count failed jobs/actions/tools/audit rows, but returned
samples and generated audit details must redact dynamic IDs and classifier
strings before exposure, including job type, action type, tool name, and audit
event type, while leaving raw local DB rows available for exact owner/admin
lookup.

## Retention

Retention should be configurable by storage class:

- Raw events.
- Chat messages.
- Summaries.
- Active memories.
- Disabled memories.
- Tool logs and audit logs.
- Display metadata / nickname history.
- Identity tombstones.

## Memory Deletion

Deletion requirements:

- Exclude deleted records from retrieval immediately.
- Preserve minimal tombstones only if needed for audit, opt-out, or preventing accidental re-linking/re-creation.
- Allow full purge mode later.
- Rebuild derived indexes after deletion.
- Ensure disabled/deleted/superseded memory cannot be injected into ordinary prompts.

## Identity and Display Data Governance

Users should be able to request:

- user memory list/disable/delete/correct/export;
- display profile and nickname history deletion/redaction;
- proactive DM opt-out;
- memory association opt-out;
- account unlink.

P0 may expose these controls through owner/admin CLI first. Ordinary user requests can become admin digests or evaluator-mediated actions until self-service commands exist.

Implemented account unlink uses `platform_accounts.status=disabled` as a
reversible local tombstone. `unlink-platform-account qq <platform-account-id>`
updates the mapping and redacted identity audit evidence in one transaction.
Inactive mappings cannot resolve to the previous canonical user or be
automatically reactivated. A newly claimed inactive-account event keeps only
its governed raw event and ingress receipt; it does not reach display/history,
chat, turn/context, Pi, action, send, or memory-extraction paths and is not
classified as an event-processing failure.

Implemented durable opt-outs are stored in `privacy_preferences`:

- `proactive_dm=opted_out` rejects proactive `dm_user` actions during action execution. User-requested DM actions are not blocked by this preference. `dm_user.target.userId` is the gateway delivery user ID, while opt-out enforcement uses `dm_user.target.canonicalUserId`; proactive DMs without a canonical target are rejected before any privacy lookup or gateway send. `dm_user` execution evidence records bounded proactive metadata (`dm_proactive`, trigger, opt-out status, redaction level, and cooldown key) after redacting free-text reason/cooldown material.
- `memory_association=opted_out` rejects user-scoped memory candidates before durable `memory_records` writes, including `propose_memory` action execution. Rejections are auditable without copying candidate content into execution evidence.
- Privacy preference reasons and audit details are redacted before durable storage. Adjacent secret/platform fragments such as `sk-...-qq-...` and assignment-shaped operator reasons such as `api_key=sk-...-qq-...` preserve both marker classes without storing raw values.
- Opt-out `reason` text is operator metadata, not prompt memory. Secret-like
  values and QQ/platform-ID-like values are redacted before durable
  `privacy_preferences.reason` and audit `details` persistence, including
  legacy/free-text values embedded after non-alphanumeric separators such as
  `legacy_qq-...` and `legacy_123456789`. Audit
  `event_id` remains an exact local lookup key; shared/displayed details must
  use redacted fields.
- `list-privacy-preferences --user <canonicalUserId>` uses the raw local
  canonical user ID for exact filtering, but inspection output must redact the
  displayed `canonicalUserId` and opt-out `reason`. Assignment-shaped user IDs
  such as `api_key=sk-...-qq-...` preserve both
  `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker classes
  in display output without mutating raw `privacy_preferences` rows.

Identity registry deletion may retain minimal tombstones. Tombstones do not enter prompt or retrieval.

Platform-provided display metadata is also treated as untrusted UI data.
Gateway-normalized `senderDisplayName` / `senderCard` fields, normalized
`raw_events.payload`, `display_profiles.current_display_name`, and
`nickname_history.display_name` store secret/platform-ID-redacted text when a
nickname or group card contains credential-shaped or QQ/platform-ID-like
substrings. Raw-event retention and deletion policy still governs the resulting
event audit source.

## Prompt and Context Boundaries

Ordinary prompts must not receive:

- `secret` / `prohibited` content;
- disabled/deleted memory;
- full allowlists/denylists;
- full account mapping tables;
- full nickname history;
- raw audit traces unless in owner/admin debug mode.

Platform IDs may be included when the current task needs them, but they should be structured fields rather than natural-language background.

Pi SDK session state must not become an unbudgeted prompt side channel. Every
active streamed or non-streamed turn owns an isolated SDK Agent session. A
settled slot is reset before reuse, and prompt/idle settlement plus output or
generator cleanup complete before that session can be recycled. Only the
current `ContextPack` may supply prior conversation history; a previous user or
group's retained SDK messages must never enter a later provider request.

Application admission covers the complete conversational workflow. One
conversation is FIFO, different conversations may run concurrently only within
the configured global cap, and delayed Attention uses the same controller.
The deadline is absolute from accepted ingress time, so queue wait, context
work, Provider work, and Pi cleanup all consume the same budget. A queued item
that expires is durably terminalized without calling the Provider. Cancellation
and timeout settle and release only the affected isolated session.

`ContextTraceRepository` stores replayable `/why` evidence with a storage final
guard: rejected-memory reasons, applied filter strings, injected identity-field
labels, and context-trace memory titles/source-context metadata are redacted for
secret-like and QQ/platform-ID-like substrings before insertion. Exact local
lookup identifiers such as context pack ID, turn ID, conversation/group IDs,
selected/candidate/rejected memory IDs, and recent message IDs remain stable in
SQLite and must be redacted at display/share boundaries.
Assignment-shaped adjacent trace metadata such as `api_key=sk-...-qq-...`
preserves both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` before durable storage.

## Audit Safety

All tools should record at least summary audit in P0.

Audit levels:

- `summary`
- `redacted_full`
- `full`
- `none` reserved for future very low-risk cases

`full` is owner/debug only, short-retention, and still passes secret scanning.

Credential access must never log secret values. If secret scanning detects a credential in input/output, rewrite audit to redacted summary and mark `redactionApplied=true`.
`AuditRepository.create()` is a durable final guard for repository-backed audit
writers: it recursively redacts secret-like and QQ/platform-ID-like text from
audit `summary` and structured `details`, including object keys and numeric
platform-ID fields such as `senderId`, `group_ids`, `targetUserId`,
`recipientGroupIds`, and `messageId`, before persistence, even for `full`
entries. It marks the persisted row as redacted when this guard changes text.
Raw `event_id` values remain local exact lookup keys and should not be copied
into shared reports. Adjacent secret/platform fragments such as `sk-...-qq-...`
and assignment-shaped fragments such as `api_key=sk-...-qq-...` preserve both
secret-assignment/openai-like and platform marker classes in persisted
`summary` / `details` evidence without storing raw values.
`MemoryRepository` applies the same durable redaction to memory lifecycle audit
summary/details and to `memory_revisions.reason` before insertion. Revision
foreign keys and raw memory IDs remain exact local lookup keys, but narrative
operator metadata must not preserve pasted token-like or platform-ID-like text.
Assignment-shaped adjacent revision/audit text such as
`api_key=sk-...-qq-...` keeps both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` markers, including structured audit detail object keys,
without storing the raw fragments.
`JobRepository` applies the same diagnostic boundary to structured job results,
job-attempt results, job/attempt error diagnostics, and worker-heartbeat details
before persistence: secret-like text, QQ/platform-ID-like text, object keys, and
numeric platform-ID fields such as `senderId`, `group_ids`, `targetUserId`,
`recipientGroupIds`, and `messageId` are redacted, while ordinary counters
remain available. Adjacent secret/platform fragments such as `sk-...-qq-...`
keep both marker classes in durable job/attempt/heartbeat diagnostics without
storing raw values. Assignment-shaped adjacent diagnostics such as
`api_key=sk-...-qq-...` likewise keep both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` marker evidence, including structured result object
keys. Job payloads, idempotency keys, worker IDs, and job IDs
remain local control/lookup evidence and must be redacted at display/share
boundaries.
Automatic extraction job payloads contain only a canonical chat-message
reference and canonical target-user reference; they do not copy inbound chat or
bot-response text. The extractor logs bounded error names/codes rather than
downstream `Error` objects because an evaluator or repository error can echo
ordinary matched chat text that secret/platform-ID redaction would not remove.
`BackgroundWorker.list()` is an operator diagnostic projection over queued work:
it redacts task type, payload, and idempotency-key display values before return
without mutating the raw in-memory task state or durable job rows used for local
scheduling and lookup. `BackgroundWorker.processNext()` also redacts returned
`TaskResult.output` and `TaskResult.error` values before in-process callers see
them and before completed output is handed to `JobRepository`; adjacent
`sk-...-qq-...` fragments must keep both secret and platform marker classes in
returned and persisted worker diagnostics while omitting raw values.
Assignment-shaped adjacent worker outputs such as `api_key=sk-...-qq-...` must
also keep both `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]`
marker classes in returned `TaskResult.output` and persisted job/attempt
results, including structured object keys.
OpenAI-like `sk-...` tokens are treated as secret-like even when they appear
inside legacy operator identifiers after non-alphanumeric separators; owner/admin
inspection output must redact those substrings before display.
Runtime structured logs must pass through the shared pino redaction hook before
write. This hook redacts secret-like strings, QQ/platform-ID-like strings,
including standalone 5-12 digit identifiers in free text, and 5-12 digit
numeric platform-ID fields including prefixed fields such as `targetUserId`,
`recipientGroupIds`, and `ownerMessageId`, and Error message/stack values. It
also covers legacy/free-text values embedded after non-alphanumeric separators, such as
`legacy_qq-...` and `legacy_123456789`, so logs do not become a side channel for
private platform identifiers. Adjacent secret/platform fragments such as
`sk-...-qq-...` must retain both `[REDACTED:openai_like_api_key]` and
`[REDACTED:platform_id]` marker evidence in structured values, dynamic object
keys, `Error.message`, and log message strings while omitting the raw fragment.
Assignment-shaped adjacent runtime diagnostics such as
`api_key=sk-...-qq-...` must likewise retain the
`[REDACTED:api_key_assignment]` marker and `[REDACTED:platform_id]` marker in
structured log values, dynamic object keys, `Error.message`, log message
strings, fatal startup output, and app-level failure logs instead of letting
assignment redaction swallow the platform marker.
Parsed reverse HTTP ingress events are never logged. Accepted events and
malformed or unexpectedly failed requests emit bounded metadata only, such as
transport, disposition/status, and received byte count; raw bodies, messages,
sender/card/nickname fields, media URLs, secrets, and platform identifiers are
excluded. Trusted listener coordinates are logged as structured host, numeric
port, and path fields so ordinary ports remain observable without weakening
free-text identifier redaction.
The deterministic local smoke script follows the same direct-console diagnostic
boundary for failure formatting: raw stack frames, source paths, dependency
paths, assignment-shaped secrets, and QQ/platform identifiers are omitted while
both assignment-secret and platform marker classes remain visible for operator
evidence.

Action execution diagnostics are also governed. Reply and `dm_user` send
failures must redact secret-like and QQ/platform-ID-like substrings before
returning the execution result and before persisting
`action_executions.error_message`. Adapter-provided legacy/free-text errors may
contain embedded platform identifiers after non-alphanumeric separators; these
must be replaced with redaction markers rather than partially displayed.
Adjacent send-failure diagnostics such as `sk-...-qq-...` must keep both secret
and platform marker classes in returned and persisted error text while omitting
raw values. Assignment-shaped adjacent diagnostics such as
`api_key=sk-...-qq-...` must likewise preserve the secret-assignment marker and
`[REDACTED:platform_id]` marker instead of letting assignment redaction swallow
the platform evidence.

`ActionRepository` is a durable final guard for repository-backed social-action
ledgers. It redacts secret-like and QQ/platform-ID-like substrings from stored
`action_decisions.actions`, `reasons`, ordinary narrative `suppressors`,
structured object keys, ID-shaped numeric fields including prefixed fields such
as `targetUserId`, `recipientGroupIds`, and `ownerMessageId`, and
action-execution `downgraded_reason`, `error_code`, `error_message`, and
`audit_entry` before insertion. Exact local control/lookup keys remain stable
when they match the internal cooldown-key shape: `target.conversationId` /
`target.userId` / `target.canonicalUserId` / `target.groupId`, `constraints.cooldownKey`,
`cooldown:<cooldownKey>` suppressors, and `executed_message_id` are local
owner/admin evidence and must be redacted at display/share boundaries instead
of being mutated in storage.
The exact unredacted decision is committed only through a versioned keyed HMAC
in `action_decisions.execution_binding`; neither the process-local key nor raw
payload is durable. The same commitment covers the exact durable evaluator
outcome and request/version/actor/context/source/timestamp/domain/turn/risk/
confidence authority metadata and the turn's conversation/trigger source.
Creation clones the complete input before validation. Executor verification
recomputes redaction for durable-row comparison, requires the decision to remain
the turn's current decision, carries the verified source across later awaits,
and never reloads redacted action JSON for side effects. This avoids placing
secret/platform-bearing execution payloads in SQLite while preventing a caller
from reusing a decision ID with a different plan, evaluator authority, or
provenance source. Superseded decisions, null legacy bindings, and bindings from
another process are non-executable.

Agent-turn and app-level failure diagnostics are governed before exposure or
persistence. Thrown Pi/runtime errors and non-completed Pi turn error messages
must redact secret-like and QQ/platform-ID-like substrings before in-memory
event-processing failure exposure and before durable
`agent_turns.response_text` writes. Legacy/free-text provider errors can embed
platform identifiers after underscores or other non-alphanumeric separators;
these must redact as whole platform markers rather than leaving prefixes such as
`legacy_qq-`. Top-level fatal console diagnostics are governed by the same
boundary: adjacent secret/platform fragments such as `sk-...-qq-...` and
assignment-shaped failed-turn diagnostics such as `api_key=sk-...-qq-...` must
keep both secret and platform marker classes in durable strings while stack
fields are replaced with `[REDACTED:stack]`.
PiAdapter direct-console runtime failure diagnostics use the same boundary:
returned failed-turn error messages and `runTurn` console diagnostics must
preserve both secret and platform marker classes for adjacent fragments such as
`sk-...-qq-...` and assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`, omit raw platform IDs and bare numeric platform-like
IDs, and replace stack fields with `[REDACTED:stack]`.
PiAdapter prompt display metadata is also prompt-adjacent governed data:
participant `display_name` / `group_card` labels and recent
`sender_display_name` labels must neutralize context delimiters and preserve
both marker classes for assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...` before model prompt construction.
Pi tool-adapter direct-console diagnostics are also display-only diagnostics:
missing-handler warnings and conversion-failure errors must redact tool names
and exception messages, preserve both marker classes for adjacent
`sk-...-qq-...` fragments and assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`, omit raw platform IDs and bare numeric platform-like
IDs, and replace stack fields with `[REDACTED:stack]`.
Network request tool output is prompt/audit-adjacent and must redact
secret-like and QQ/platform-ID-like text before returning response bodies,
headers, status text, or network error messages to callers. Adjacent
`sk-...-qq-...` fragments must preserve both marker classes, including
assignment-shaped header values where token assignment redaction could
otherwise remove the already-detected platform marker.
File-operation tool output follows the same prompt/audit-adjacent rule for file
contents, output paths, directory entry names/paths, audit summaries, validation
reasons, and filesystem error messages. Adjacent `sk-...-qq-...` fragments in
file contents or assignment-shaped filenames must preserve both marker classes
without returning raw platform IDs or bare numeric platform-like IDs.
The private owner/admin `runtime.tools` inspector exposes only bounded redacted
tool names, capabilities, current-context availability, evaluator requirements,
counts, truncation/redaction flags, coarse workspace/web-fetch registration
state, and the configured origin count. It never returns workspace roots,
origin values, permission identifier lists, descriptions, handlers, payloads,
credentials, private identifiers, or diagnostics. Inspection does not mutate
the registry, configuration, filesystem, network, or durable domain state;
static environment configuration remains the optional-tool authority.
Production workspace access is absent unless one absolute existing root is
configured. `workspace.list` exposes bounded non-recursive metadata only;
`workspace.read_text` reads at most 2,048 bytes from one strict UTF-8 regular
file. Both are private owner/admin tools. The text reader rejects hidden,
credential-shaped, database, log, key/certificate, and runtime-data paths plus
every symlink path component before opening, returns only relative paths, and
uses fixed path-free failures. Legacy binary/base64 and general read/write/delete
handlers remain outside the production registry.
Production network text access is independently absent unless at least one
exact HTTPS origin is configured. `web.fetch_text` is private owner/admin and
evaluator-required. It accepts only a URL, sends no caller headers/body/cookies/
credentials, rejects sensitive URL data, validates every A/AAAA result as public,
pins the request address, and permits at most three same-initiating-origin
redirects with fresh validation and pinning. It streams at most 2,048 source
bytes from successful identity-encoded textual responses, requires strict UTF-8,
redacts the result, and exposes no remote headers, status text, or diagnostics.
Fixed failures, a 5,000-ms cooperative runtime limit, an 8,192-byte output cap,
and no retries bound the call. The legacy general `network_request` remains
unregistered. Evaluator approval precedes the GET but cannot undo remote
observation or logging; registration rollback only prevents future requests.
SQLite verbose SQL output is a direct-console diagnostic boundary. When
`initDatabase({ verbose: true })` is used for local debugging, displayed SQL must
redact secret-like and QQ/platform-ID-like substrings, including adjacent
`sk-...-qq-...` fragments with both marker classes preserved, before
`better-sqlite3` verbose hooks reach `console.log`. Assignment-shaped adjacent
SQL literals such as `api_key=sk-...-qq-...` must likewise preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker classes
without printing raw fragments.
On POSIX, writable `initDatabase()` treats SQLite file mode as a privacy
boundary: it creates or remediates the resolved main database and existing
WAL/SHM sidecars to `0600` before serving. It does not mutate the global umask,
and readonly opens do not change filesystem state. Private parent-directory
ownership remains required; Windows deployments use restrictive ACLs instead.
The container runs as a non-root numeric identity, and its bind directory plus
SQLite main/WAL/SHM files must share that owner. A legacy root-owned `0600`
database requires a stopped-service ownership migration; weakening its mode or
recursively changing co-located SnowLuma state is not an acceptable workaround.
Checked local stacks expose only a dedicated LetheBot data directory to the
application and bind VNC/WebUI/OneBot/application ports to loopback. Sharing a
numeric UID does not authorize LetheBot to see SnowLuma config, QQ state, or
logs.

OneBot deployment and verification operator output is governed display data.
`deploy-napcat` / `verify-napcat` may need raw URLs and tokens for the local
connection attempt, but console output must redact token values, secret-like
substrings, QQ/platform-ID-like substrings, and embedded legacy/free-text
platform identifiers before display. `deploy-napcat` HTTP verification
diagnostics and spawned `verify-napcat` operator output must also preserve both
marker classes for assignment-shaped adjacent OneBot API/operator values such as
`api_key=sk-...-qq-...` without printing raw fragments.
Governance CLI validation and Commander parser errors are also governed display
data. Invalid operator-provided filter values may contain assignment-shaped
adjacent fragments such as `api_key=sk-...-qq-...`; stderr must keep both
secret-assignment and platform marker classes while omitting raw fragments and
must not mutate DB state.
Governance CLI memory-review inspection is a display/share boundary as well:
assignment-shaped adjacent memory IDs in review details or exact `--memory`
filters must preserve both marker classes in `list-memory-reviews` and
`summarize-memory-reviews` output while raw SQLite identifiers remain local
lookup keys.
Ops maintenance CLI output follows the same operator-display boundary. Backup,
restore, metrics, retention, and worker-soak JSON display paths plus parser
errors may contain assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`; stdout/stderr must keep both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` without exposing
raw fragments, while raw local filesystem paths and DB rows remain unchanged
for the actual operation. Metrics JSON aggregate keys derived from DB text must
preserve the same two marker classes for assignment-shaped adjacent values while
leaving raw metric source rows unchanged.
Governance health aggregate keys derived from DB text, including action types,
audit event/risk values, job types, worker heartbeat types, and
event-processing stages, follow the same display boundary: assignment-shaped
adjacent fragments such as `api_key=sk-...-qq-...` must preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` without mutating
raw SQLite rows.

OneBot gateway event-handler failures are direct-console/readiness/listener
diagnostics. Listener-thrown errors must be formatted through bounded redaction
before `console.error`, readiness `lastError`, or emitted adapter `error` events;
assignment-shaped adjacent fragments such as `api_key=sk-...-qq-...` must keep
both `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]`, while raw
fragments, source paths, dependency paths, and stack frames remain omitted.
OneBot gateway send API diagnostics are governed display/readiness data. HTTP
and WebSocket send API response `message` / `wording` fields, thrown request
errors, and adapter readiness `lastError` values must redact secret-like and
QQ/platform-ID-like substrings before being surfaced to action execution,
operators, health/readiness callers, or logs.
OneBot WebSocket lifecycle diagnostics use the same boundary: open-factory
failures, socket `error` events, close reasons, invalid JSON parse diagnostics,
and emitted adapter `error` events must not expose secret-like or
QQ/platform-ID-like substrings through readiness or listener output. WebSocket
close while send API requests are pending must clear pending readiness counts and
reject callers with bounded local diagnostics rather than raw close reasons.
Adapter shutdown must preserve that cleanup/redaction boundary even when socket
close itself throws a sensitive diagnostic. Synchronous WebSocket `socket.send()`
failures after pending request creation must also clear the pending request and
redact caller/readiness diagnostics without creating unhandled raw-error promise
rejections.

Local acceptance evidence tooling is also governed display data. Generated
templates must be redaction-first, validation findings must report rule IDs and
line numbers without echoing matched values, and evidence CLI JSON/errors must
redact secret-like and QQ/platform-ID-like substrings in displayed paths. This
includes legacy/free-text prefixed platform identifiers such as `legacy_qq-...`
and underscore-delimited numeric IDs.

Durable event-processing failure diagnostics must use internal IDs and hashes
only. They must not store platform IDs, message text, display names, or raw
error strings; operator inspection commands should show hashed correlation
fields and redacted details only.

The event-processing admission ledger stores only its internal raw-event lookup
key, bounded lifecycle states/reason codes, and timestamps. Startup recovery
logs and metrics expose aggregate counts only; they must not copy the normalized
payload, message text, platform identifiers, parser diagnostics, or raw errors.

## Tool Safety

Tools should declare:

- capabilities;
- required permissions;
- evaluator policy: `required | bypass`;
- audit level;
- sandbox policy;
- output sensitivity;
- whether they can mutate state;
- whether they can access network;
- whether results are persisted;
- whether they can run long-lived processes.

Dangerous tools should require explicit policy checks before execution. Bypassing LLM evaluator review does not bypass permissions, sandboxing, deterministic hard policy, or audit.

`ToolCallRepository` is a durable final guard for repository-backed tool-call
ledgers. It redacts secret-like and QQ/platform-ID-like substrings from stored
tool input/output payload strings, structured object keys, ID-shaped numeric
fields including prefixed fields such as `targetUserId`, `recipientGroupIds`,
and `ownerMessageId`, `error_code`, and `error_message` before insertion, and
sets `secrets_redacted=1` when the guard changes stored data. Exact local
linkage fields such as `turn_id`, raw actor lookup keys, and tool names remain
stable for owner/admin queries; do not copy raw local identifiers into shared
reports.

See `tool-registry.md`.
