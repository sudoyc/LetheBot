const MAX_ENTRIES = 100;
const MAX_DETAIL_ITEMS = 32;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const RESTRICTED_TEXT = '[REDACTED:restricted_memory]';
const PRIMARY = 'worker-heartbeat-primary';
const SECONDARY = 'worker-heartbeat-secondary';
const PRIMARY_NUMBER = PRIMARY + ' worker-heartbeat-number';
const SECONDARY_NUMBER = SECONDARY + ' worker-heartbeat-number';
const REDACTION = 'tool-call-redaction';
const SCOPE_LABELS = {
global: 'Global memory',
user: 'User memory',
group: 'Group memory',
system: 'System memory',
private: 'Private conversation memory',
conversation_group: 'Group conversation memory',
};
const VISIBILITIES = [
'private_only',
'same_user_any_context',
'same_group_only',
'owner_admin_only',
'public',
];
const SENSITIVITIES = ['normal', 'personal', 'sensitive', 'secret', 'prohibited'];
const AUTHORITIES = ['user_stated', 'inferred', 'tool_derived', 'system'];
const KINDS = ['preference', 'fact', 'constraint', 'summary', 'reflection', 'procedure'];
const STATES = ['proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted'];
const SOURCE_TYPES = ['raw_event', 'chat_message', 'tool_output', 'worker_extraction', 'user_command', 'other'];
const SOURCE_RESOLUTIONS = ['internal', 'external', 'legacy_unresolved', 'other'];
const REVISION_CHANGES = ['create', 'update', 'approve', 'reject', 'supersede', 'disable', 'delete', 'restore', 'other'];
const PROVENANCE_ACTORS = ['user', 'evaluator', 'tool', 'worker', 'admin', 'human', 'system', 'local_admin', 'other', 'unknown'];
const AUDIT_LEVELS = ['summary', 'redacted_full', 'full', 'other'];
const RISK_LEVELS = ['low', 'medium', 'high', 'prohibited', 'other'];
const REVIEW_KINDS = ['conflict', 'consolidation', 'decay'];
const REVIEW_EFFECTS = ['resolve_conflict', 'consolidate', 'disable'];
const REVIEW_STATES = ['pending_review', 'approved', 'rejected', 'expired', 'applied', 'rolled_back'];
const REVIEW_EFFECT_BY_KIND = {
conflict: 'resolve_conflict',
consolidation: 'consolidate',
decay: 'disable',
};
const REVIEW_REVISION_BY_STATE = {
pending_review: 1,
approved: 2,
rejected: 2,
expired: 2,
applied: 3,
rolled_back: 4,
};
const REVIEW_REASONS = [
'same_boundary_title_different_content',
'same_boundary_title_and_content',
'stale',
'low_confidence',
'low_importance',
];
const REVIEW_EFFECT_ROLES = [null, 'retained', 'disable_target'];
const REVIEW_CANDIDATE_ROLES = [
'conflict_candidate',
'retained',
'supersede',
'disable_target',
];
const REVIEW_TRANSITIONS = ['propose', 'approve', 'reject', 'expire', 'apply', 'rollback'];
const REVIEW_ACTORS = [
'owner',
'admin',
'trusted_user',
'user',
'group_admin',
'system_worker',
'evaluator',
'tool',
];
const REVIEW_CONTEXTS = [
'private_chat',
'group_chat',
'admin_cli',
'background_worker',
'internal',
];
const REVIEW_STATE_BY_TRANSITION = {
propose: 'pending_review',
approve: 'approved',
reject: 'rejected',
expire: 'expired',
apply: 'applied',
rollback: 'rolled_back',
};
const REVIEW_SCOPE_KINDS = ['global', 'user', 'group', 'conversation', 'system'];
const APPROVAL_DURABLE_EFFECTS = [
'proposal_state_transition',
'proposal_revision_append',
'audit_event_append',
];
const APPROVAL_UNAVAILABLE_EFFECTS = ['memory_record_mutation'];
const RECORD_KEYS = [
'recordRef',
'scopeKind',
'visibility',
'sensitivity',
'authority',
'kind',
'title',
'contentPreview',
'state',
'confidence',
'importance',
'sourceCount',
'revisionCount',
'createdAt',
'updatedAt',
'textHidden',
'titleRedacted',
'titleTruncated',
'contentRedacted',
'contentTruncated',
'handle',
'handleExpiresAt',
];
const RECORD_DETAIL_KEYS = [
'record',
'sources',
'sourcesTruncated',
'revisions',
'revisionsTruncated',
'audit',
'auditTruncated',
];
const RECORD_SOURCE_KEYS = [
'sourceRef',
'sourceType',
'resolutionState',
'extractorClass',
'sourceTimestamp',
];
const RECORD_REVISION_KEYS = [
'revisionRef',
'revisionNumber',
'changeType',
'actorClass',
'evaluatorLinked',
'createdAt',
];
const RECORD_AUDIT_KEYS = [
'auditRef',
'timestamp',
'level',
'eventType',
'summary',
'summaryRedacted',
'summaryTruncated',
'evaluatorLinked',
'detailsHidden',
];
const REVIEW_KEYS = [
'proposalRef',
'kind',
'effectType',
'lifecycleState',
'scopeKind',
'candidateFingerprint',
'confidence',
'candidateCount',
'reasonCodes',
'revisionCount',
'currentRevisionNumber',
'createdAt',
'updatedAt',
'handle',
'handleExpiresAt',
];
const REVIEW_DETAIL_KEYS = [
'proposalRef',
'kind',
'effectType',
'lifecycleState',
'scopeKind',
'candidateFingerprint',
'confidence',
'candidateCount',
'reasonCodes',
'revisionCount',
'currentRevisionNumber',
'createdAt',
'updatedAt',
'effectMemoryRole',
'candidates',
'candidatesTruncated',
'revisions',
'revisionsTruncated',
];
const REVIEW_CANDIDATE_KEYS = [
'candidateOrdinal',
'memoryRef',
'effectRole',
'expectedState',
'recordFingerprint',
'sourceCount',
'sourceFingerprint',
];
const REVIEW_REVISION_KEYS = [
'revisionNumber',
'transition',
'previousState',
'newState',
'actorClass',
'invocationContext',
'reasonCode',
'createdAt',
];
const APPROVAL_PREVIEW_KEYS = [
'action',
'scope',
'proposalKind',
'proposalRef',
'proposedEffect',
'affectedRecords',
'current',
'expected',
'rollback',
'previewHandle',
'previewExpiresAt',
'previewDigest',
];
const APPROVAL_SCOPE_KEYS = ['scopeKind', 'fingerprint'];
const APPROVAL_AFFECTED_KEYS = ['count', 'fingerprint'];
const APPROVAL_CURRENT_KEYS = ['lifecycleState', 'revisionNumber'];
const APPROVAL_EXPECTED_KEYS = [
'lifecycleState',
'revisionNumber',
'durableEffects',
'unavailableEffects',
];
const APPROVAL_ROLLBACK_KEYS = ['supported', 'boundary'];
const APPLICATION_PREVIEW_KEYS = [
'action',
'scope',
'proposalKind',
'proposalRef',
'proposedEffect',
'affectedRecords',
'selection',
'current',
'expected',
'rollback',
'previewHandle',
'previewExpiresAt',
'previewDigest',
];
const APPLICATION_AFFECTED_KEYS = ['count', 'fingerprint', 'roles'];
const APPLICATION_ROLE_KEYS = ['role', 'count', 'fingerprint'];
const APPLICATION_SELECTION_KEYS = ['required'];
const APPLICATION_EXPECTED_KEYS = [
'lifecycleState',
'revisionNumber',
'durableEffects',
'retrievalConsequences',
];
const APPLICATION_DURABLE_EFFECTS = [
'proposal_state_transition',
'proposal_revision_append',
'audit_event_append',
'memory_record_revision_append',
'proposal_effect_evidence_append',
];
const APPROVAL_CONFIRMATION_KEYS = [
'action',
'outcome',
'proposalRef',
'current',
'evidence',
'memoryRecordMutation',
'rollback',
];
const APPROVAL_CONFIRMATION_CURRENT_KEYS = ['lifecycleState', 'revisionNumber'];
const APPROVAL_CONFIRMATION_EVIDENCE_KEYS = ['transition', 'revisionRef', 'auditRef'];
const APPROVAL_CONFIRMATION_EXPECTATION_KEYS = ['proposalRef', 'expectedRevisionNumber'];
const RECORD_SUMMARY_KEYS = RECORD_KEYS.slice(0, -2);
const REVIEW_SUMMARY_KEYS = REVIEW_KEYS.slice(0, -2);

function exactObject(value, required, optional = []) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
const keys = Object.keys(value);
return required.every((key) => Object.hasOwn(value, key))
&& keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedText(value, limit) {
return typeof value === 'string' && Array.from(value).length <= limit;
}

function canonicalDate(value) {
if (typeof value !== 'string') return false;
const date = new Date(value);
return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function safeCount(value) {
return Number.isSafeInteger(value) && value >= 0;
}

function normalizeMemoryScopeEntry(value) {
if (!exactObject(
value,
['fingerprint', 'scopeKind', 'label', 'handle', 'expiresAt'],
['conversationType'],
)) return null;
if (!REFERENCE_PATTERN.test(value.fingerprint)
|| !OPAQUE_PATTERN.test(value.handle)
|| !Number.isSafeInteger(value.expiresAt)
|| value.expiresAt < 0) return null;
let expectedLabel = SCOPE_LABELS[value.scopeKind];
if (value.scopeKind === 'conversation') {
if (value.conversationType !== 'private' && value.conversationType !== 'group') return null;
expectedLabel = value.conversationType === 'private'
? SCOPE_LABELS.private
: SCOPE_LABELS.conversation_group;
} else if (Object.hasOwn(value, 'conversationType')) {
return null;
}
if (!expectedLabel || value.label !== expectedLabel) return null;
return {
fingerprint: value.fingerprint,
scopeKind: value.scopeKind,
...(value.conversationType ? { conversationType: value.conversationType } : {}),
label: value.label,
handle: value.handle,
expiresAt: value.expiresAt,
};
}

function normalizeMemoryScopeCatalog(value) {
if (!exactObject(value, ['entries', 'truncated'])
|| !Array.isArray(value.entries)
|| value.entries.length > MAX_ENTRIES
|| typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map(normalizeMemoryScopeEntry);
if (entries.some((entry) => entry === null)) return null;
const fingerprints = new Set(entries.map((entry) => entry.fingerprint));
const handles = new Set(entries.map((entry) => entry.handle));
if (fingerprints.size !== entries.length || handles.size !== entries.length) return null;
return { entries, truncated: value.truncated };
}

function normalizeMemoryReviewScopeCatalog(value) {
return normalizeMemoryScopeCatalog(value);
}

function normalizeMemoryRecord(value, scopeKind) {
if (!exactObject(value, RECORD_KEYS, ['expiresAt'])
|| !REFERENCE_PATTERN.test(value.recordRef)
|| value.scopeKind !== scopeKind
|| !VISIBILITIES.includes(value.visibility)
|| !SENSITIVITIES.includes(value.sensitivity)
|| !AUTHORITIES.includes(value.authority)
|| !KINDS.includes(value.kind)
|| !boundedText(value.title, 160)
|| !boundedText(value.contentPreview, 512)
|| !STATES.includes(value.state)
|| typeof value.confidence !== 'number'
|| !Number.isFinite(value.confidence)
|| value.confidence < 0
|| value.confidence > 1
|| typeof value.importance !== 'number'
|| !Number.isFinite(value.importance)
|| value.importance < 0
|| value.importance > 1
|| !safeCount(value.sourceCount)
|| !safeCount(value.revisionCount)
|| !canonicalDate(value.createdAt)
|| !canonicalDate(value.updatedAt)
|| (Object.hasOwn(value, 'expiresAt') && !canonicalDate(value.expiresAt))
|| typeof value.textHidden !== 'boolean'
|| typeof value.titleRedacted !== 'boolean'
|| typeof value.titleTruncated !== 'boolean'
|| typeof value.contentRedacted !== 'boolean'
|| typeof value.contentTruncated !== 'boolean'
|| !OPAQUE_PATTERN.test(value.handle)
|| !Number.isSafeInteger(value.handleExpiresAt)
|| value.handleExpiresAt < 0) return null;
const restricted = value.sensitivity === 'secret' || value.sensitivity === 'prohibited';
if (value.textHidden !== restricted) return null;
if (restricted && (
value.title !== RESTRICTED_TEXT
|| value.contentPreview !== RESTRICTED_TEXT
|| !value.titleRedacted
|| !value.contentRedacted
)) return null;
return { ...value };
}

function normalizeMemoryRecordPage(value, scopeKind) {
if (!exactObject(value, ['entries', 'truncated'])
|| !Array.isArray(value.entries)
|| value.entries.length > MAX_ENTRIES
|| typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => normalizeMemoryRecord(entry, scopeKind));
if (entries.some((entry) => entry === null)) return null;
const references = new Set(entries.map((entry) => entry.recordRef));
const handles = new Set(entries.map((entry) => entry.handle));
if (references.size !== entries.length || handles.size !== entries.length) return null;
return { entries, truncated: value.truncated };
}

function normalizeMemoryRecordDetail(value) {
if (!exactObject(value, RECORD_DETAIL_KEYS)
|| !exactObject(value.record, RECORD_SUMMARY_KEYS, ['expiresAt'])
|| !normalizeMemoryRecord({
...value.record,
handle: 'A'.repeat(43),
handleExpiresAt: 0,
}, value.record.scopeKind)
|| value.record.createdAt > value.record.updatedAt
|| !Array.isArray(value.sources)
|| value.sources.length > MAX_DETAIL_ITEMS
|| typeof value.sourcesTruncated !== 'boolean'
|| value.sources.length !== Math.min(value.record.sourceCount, MAX_DETAIL_ITEMS)
|| value.sourcesTruncated !== (value.record.sourceCount > MAX_DETAIL_ITEMS)
|| !Array.isArray(value.revisions)
|| value.revisions.length > MAX_DETAIL_ITEMS
|| typeof value.revisionsTruncated !== 'boolean'
|| value.revisions.length !== Math.min(value.record.revisionCount, MAX_DETAIL_ITEMS)
|| value.revisionsTruncated !== (value.record.revisionCount > MAX_DETAIL_ITEMS)
|| !Array.isArray(value.audit)
|| value.audit.length > MAX_DETAIL_ITEMS
|| typeof value.auditTruncated !== 'boolean'
|| (value.auditTruncated && value.audit.length < MAX_DETAIL_ITEMS)) return null;
const record = { ...value.record };
const sources = value.sources.map((source) => {
if (!exactObject(source, RECORD_SOURCE_KEYS)
|| !REFERENCE_PATTERN.test(source.sourceRef)
|| !SOURCE_TYPES.includes(source.sourceType)
|| !SOURCE_RESOLUTIONS.includes(source.resolutionState)
|| !PROVENANCE_ACTORS.includes(source.extractorClass)
|| !canonicalDate(source.sourceTimestamp)) return null;
return { ...source };
});
if (sources.some((source) => source === null)
|| new Set(sources.map((source) => source.sourceRef)).size !== sources.length
|| sources.some((source, index) => index > 0
&& source.sourceTimestamp < sources[index - 1].sourceTimestamp)) return null;
const revisions = value.revisions.map((revision) => {
if (!exactObject(revision, RECORD_REVISION_KEYS, [
'previousLifecycleState',
'newLifecycleState',
'reason',
'reasonRedacted',
'reasonTruncated',
])) return null;
const hasReason = Object.hasOwn(revision, 'reason');
if (!REFERENCE_PATTERN.test(revision.revisionRef)
|| !Number.isSafeInteger(revision.revisionNumber)
|| revision.revisionNumber < 1
|| !REVISION_CHANGES.includes(revision.changeType)
|| !PROVENANCE_ACTORS.includes(revision.actorClass)
|| (Object.hasOwn(revision, 'previousLifecycleState')
&& !STATES.includes(revision.previousLifecycleState))
|| (Object.hasOwn(revision, 'newLifecycleState')
&& !STATES.includes(revision.newLifecycleState))
|| Object.hasOwn(revision, 'reasonRedacted') !== hasReason
|| Object.hasOwn(revision, 'reasonTruncated') !== hasReason
|| (hasReason && (
!boundedText(revision.reason, 160)
|| typeof revision.reasonRedacted !== 'boolean'
|| typeof revision.reasonTruncated !== 'boolean'
))
|| (hasReason && record.textHidden && (
revision.reason !== RESTRICTED_TEXT
|| !revision.reasonRedacted
|| revision.reasonTruncated
))
|| typeof revision.evaluatorLinked !== 'boolean'
|| !canonicalDate(revision.createdAt)) return null;
return { ...revision };
});
if (revisions.some((revision) => revision === null)
|| new Set(revisions.map((revision) => revision.revisionRef)).size !== revisions.length
|| new Set(revisions.map((revision) => revision.revisionNumber)).size !== revisions.length
|| revisions.some((revision, index) => index > 0
&& revision.revisionNumber <= revisions[index - 1].revisionNumber)) return null;
const audit = value.audit.map((entry) => {
if (!exactObject(entry, RECORD_AUDIT_KEYS, ['riskLevel'])
|| !REFERENCE_PATTERN.test(entry.auditRef)
|| !canonicalDate(entry.timestamp)
|| !AUDIT_LEVELS.includes(entry.level)
|| !boundedText(entry.eventType, 96)
|| !boundedText(entry.summary, 256)
|| (Object.hasOwn(entry, 'riskLevel') && !RISK_LEVELS.includes(entry.riskLevel))
|| typeof entry.summaryRedacted !== 'boolean'
|| typeof entry.summaryTruncated !== 'boolean'
|| (record.textHidden && (
entry.summary !== RESTRICTED_TEXT
|| !entry.summaryRedacted
|| entry.summaryTruncated
))
|| typeof entry.evaluatorLinked !== 'boolean'
|| entry.detailsHidden !== true) return null;
return { ...entry };
});
if (audit.some((entry) => entry === null)
|| new Set(audit.map((entry) => entry.auditRef)).size !== audit.length
|| audit.some((entry, index) => index > 0
&& entry.timestamp > audit[index - 1].timestamp)) return null;
return { ...value, record, sources, revisions, audit };
}

function recordSummariesAgree(detail, selectedRecord) {
return RECORD_SUMMARY_KEYS.every((key) => detail.record[key] === selectedRecord[key])
&& Object.hasOwn(detail.record, 'expiresAt') === Object.hasOwn(selectedRecord, 'expiresAt')
&& detail.record.expiresAt === selectedRecord.expiresAt;
}

function normalizeMemoryReview(value, scopeKind) {
if (!exactObject(value, REVIEW_KEYS, ['expiresAt'])
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| !REVIEW_KINDS.includes(value.kind)
|| !REVIEW_EFFECTS.includes(value.effectType)
|| REVIEW_EFFECT_BY_KIND[value.kind] !== value.effectType
|| !REVIEW_STATES.includes(value.lifecycleState)
|| value.scopeKind !== scopeKind
|| !FINGERPRINT_PATTERN.test(value.candidateFingerprint)
|| typeof value.confidence !== 'number'
|| !Number.isFinite(value.confidence)
|| value.confidence < 0
|| value.confidence > 1
|| !safeCount(value.candidateCount)
|| value.candidateCount === 0
|| (value.kind === 'decay' ? value.candidateCount !== 1 : value.candidateCount < 2)
|| !Array.isArray(value.reasonCodes)
|| value.reasonCodes.length > REVIEW_REASONS.length
|| value.reasonCodes.some((reason) => !REVIEW_REASONS.includes(reason))
|| new Set(value.reasonCodes).size !== value.reasonCodes.length
|| !safeCount(value.revisionCount)
|| value.revisionCount === 0
|| value.currentRevisionNumber !== value.revisionCount
|| REVIEW_REVISION_BY_STATE[value.lifecycleState] !== value.currentRevisionNumber
|| !canonicalDate(value.createdAt)
|| !canonicalDate(value.updatedAt)
|| value.createdAt > value.updatedAt
|| (Object.hasOwn(value, 'expiresAt') && !canonicalDate(value.expiresAt))
|| !OPAQUE_PATTERN.test(value.handle)
|| !Number.isSafeInteger(value.handleExpiresAt)
|| value.handleExpiresAt < 0
|| !Number.isFinite(new Date(value.handleExpiresAt).getTime())) return null;
return { ...value };
}

function normalizeMemoryReviewPage(value, scopeKind) {
if (!exactObject(value, ['entries', 'truncated'])
|| !Array.isArray(value.entries)
|| value.entries.length > MAX_ENTRIES
|| typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => normalizeMemoryReview(entry, scopeKind));
if (entries.some((entry) => entry === null)) return null;
const references = new Set(entries.map((entry) => entry.proposalRef));
const handles = new Set(entries.map((entry) => entry.handle));
if (references.size !== entries.length || handles.size !== entries.length) return null;
return { entries, truncated: value.truncated };
}

function normalizeMemoryReviewDetail(value) {
if (!exactObject(value, REVIEW_DETAIL_KEYS, ['expiresAt', 'effectMemoryRef'])) return null;
const summary = Object.fromEntries(REVIEW_SUMMARY_KEYS.map((key) => [key, value[key]]));
if (Object.hasOwn(value, 'expiresAt')) summary.expiresAt = value.expiresAt;
summary.handle = 'A'.repeat(43);
summary.handleExpiresAt = 0;
if (!normalizeMemoryReview(summary, value.scopeKind)
|| !REVIEW_EFFECT_ROLES.includes(value.effectMemoryRole)
|| (Object.hasOwn(value, 'effectMemoryRef') && !REFERENCE_PATTERN.test(value.effectMemoryRef))
|| Object.hasOwn(value, 'effectMemoryRef') !== (value.effectMemoryRole !== null)
|| !Array.isArray(value.candidates)
|| value.candidates.length !== Math.min(value.candidateCount, MAX_DETAIL_ITEMS)
|| typeof value.candidatesTruncated !== 'boolean'
|| value.candidatesTruncated !== (value.candidateCount > MAX_DETAIL_ITEMS)
|| !Array.isArray(value.revisions)
|| value.revisions.length !== Math.min(value.revisionCount, MAX_DETAIL_ITEMS)
|| typeof value.revisionsTruncated !== 'boolean'
|| value.revisionsTruncated !== (value.revisionCount > MAX_DETAIL_ITEMS)) return null;
const candidates = value.candidates.map((candidate, index) => {
if (!exactObject(candidate, REVIEW_CANDIDATE_KEYS)
|| candidate.candidateOrdinal !== index
|| !REFERENCE_PATTERN.test(candidate.memoryRef)
|| !REVIEW_CANDIDATE_ROLES.includes(candidate.effectRole)
|| candidate.expectedState !== 'active'
|| !FINGERPRINT_PATTERN.test(candidate.recordFingerprint)
|| !safeCount(candidate.sourceCount)
|| !FINGERPRINT_PATTERN.test(candidate.sourceFingerprint)) return null;
return { ...candidate };
});
if (candidates.some((candidate) => candidate === null)
|| new Set(candidates.map((candidate) => candidate.memoryRef)).size !== candidates.length) {
return null;
}
const retained = candidates.filter((candidate) => candidate.effectRole === 'retained');
if ((value.kind === 'conflict' && (
value.effectMemoryRole !== null
|| candidates.some((candidate) => candidate.effectRole !== 'conflict_candidate')
)) || (value.kind === 'consolidation' && (
value.effectMemoryRole !== 'retained'
|| candidates.some((candidate) => !['retained', 'supersede'].includes(candidate.effectRole))
|| retained.length > 1
|| (!value.candidatesTruncated && retained.length !== 1)
|| (retained.length === 1 && retained[0].memoryRef !== value.effectMemoryRef)
)) || (value.kind === 'decay' && (
value.effectMemoryRole !== 'disable_target'
|| candidates.length !== 1
|| candidates[0].effectRole !== 'disable_target'
|| candidates[0].memoryRef !== value.effectMemoryRef
))) return null;
const firstRevisionNumber = value.revisionCount - value.revisions.length + 1;
const revisions = value.revisions.map((revision, index) => {
if (!exactObject(revision, REVIEW_REVISION_KEYS)
|| revision.revisionNumber !== firstRevisionNumber + index
|| !REVIEW_TRANSITIONS.includes(revision.transition)
|| (revision.previousState !== null && !REVIEW_STATES.includes(revision.previousState))
|| !REVIEW_STATES.includes(revision.newState)
|| REVIEW_STATE_BY_TRANSITION[revision.transition] !== revision.newState
|| !REVIEW_ACTORS.includes(revision.actorClass)
|| !REVIEW_CONTEXTS.includes(revision.invocationContext)
|| !boundedText(revision.reasonCode, 512)
|| revision.reasonCode.length === 0
|| !canonicalDate(revision.createdAt)) return null;
return { ...revision };
});
if (revisions.some((revision) => revision === null)
|| (firstRevisionNumber === 1 && (
revisions[0].transition !== 'propose' || revisions[0].previousState !== null
))
|| (firstRevisionNumber > 1 && revisions[0].previousState === null)
|| revisions.some((revision, index) => index > 0 && (
revision.previousState !== revisions[index - 1].newState
|| revision.createdAt < revisions[index - 1].createdAt
))
|| revisions[revisions.length - 1].newState !== value.lifecycleState
|| revisions[revisions.length - 1].createdAt !== value.updatedAt) return null;
return { ...value, candidates, revisions };
}

function reviewSummariesAgree(detail, selectedReview) {
return REVIEW_SUMMARY_KEYS.every((key) => key === 'reasonCodes'
? detail.reasonCodes.length === selectedReview.reasonCodes.length
&& detail.reasonCodes.every((reason, index) => reason === selectedReview.reasonCodes[index])
: detail[key] === selectedReview[key])
&& Object.hasOwn(detail, 'expiresAt') === Object.hasOwn(selectedReview, 'expiresAt')
&& detail.expiresAt === selectedReview.expiresAt;
}

function exactList(value, expected) {
return Array.isArray(value)
&& value.length === expected.length
&& value.every((entry, index) => entry === expected[index]);
}

function normalizeMemoryApprovalPreview(value, selectedReview, selectedDetail, now = Date.now()) {
if (!exactObject(value, APPROVAL_PREVIEW_KEYS)
|| !exactObject(value.scope, APPROVAL_SCOPE_KEYS)
|| !exactObject(value.affectedRecords, APPROVAL_AFFECTED_KEYS)
|| !exactObject(value.current, APPROVAL_CURRENT_KEYS)
|| !exactObject(value.expected, APPROVAL_EXPECTED_KEYS)
|| !exactObject(value.rollback, APPROVAL_ROLLBACK_KEYS)
|| value.action !== 'memory.maintenance.review.approve'
|| !REVIEW_SCOPE_KINDS.includes(value.scope.scopeKind)
|| !REFERENCE_PATTERN.test(value.scope.fingerprint)
|| !REVIEW_KINDS.includes(value.proposalKind)
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| !REVIEW_EFFECTS.includes(value.proposedEffect)
|| REVIEW_EFFECT_BY_KIND[value.proposalKind] !== value.proposedEffect
|| !safeCount(value.affectedRecords.count)
|| value.affectedRecords.count === 0
|| !FINGERPRINT_PATTERN.test(value.affectedRecords.fingerprint)
|| value.current.lifecycleState !== 'pending_review'
|| !safeCount(value.current.revisionNumber)
|| value.current.revisionNumber === 0
|| value.expected.lifecycleState !== 'approved'
|| !safeCount(value.expected.revisionNumber)
|| value.expected.revisionNumber !== value.current.revisionNumber + 1
|| !exactList(value.expected.durableEffects, APPROVAL_DURABLE_EFFECTS)
|| !exactList(value.expected.unavailableEffects, APPROVAL_UNAVAILABLE_EFFECTS)
|| value.rollback.supported !== false
|| value.rollback.boundary !== 'approval_does_not_apply_memory_effects'
|| !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt)
|| value.previewExpiresAt < 0
|| !Number.isFinite(new Date(value.previewExpiresAt).getTime())
|| !FINGERPRINT_PATTERN.test(value.previewDigest)) return { state: 'malformed' };
const detail = normalizeMemoryReviewDetail(selectedDetail);
if (!detail
|| !selectedReview
|| !reviewSummariesAgree(detail, selectedReview)
|| !REFERENCE_PATTERN.test(selectedReview.scopeFingerprint)
|| !Number.isSafeInteger(selectedReview.scopeExpiresAt)
|| selectedReview.scopeExpiresAt < 0
|| value.scope.scopeKind !== detail.scopeKind
|| value.scope.fingerprint !== selectedReview.scopeFingerprint
|| value.proposalKind !== detail.kind
|| value.proposalRef !== detail.proposalRef
|| value.proposedEffect !== detail.effectType
|| value.affectedRecords.count !== detail.candidateCount
|| value.affectedRecords.fingerprint !== detail.candidateFingerprint
|| value.current.lifecycleState !== detail.lifecycleState
|| value.current.revisionNumber !== detail.currentRevisionNumber
|| value.previewExpiresAt > selectedReview.handleExpiresAt
|| value.previewExpiresAt > selectedReview.scopeExpiresAt
|| value.previewExpiresAt <= now) return { state: 'stale' };
return {
state: 'populated',
preview: {
action: 'memory.maintenance.review.approve',
scope: { ...value.scope },
proposalKind: value.proposalKind,
proposalRef: value.proposalRef,
proposedEffect: value.proposedEffect,
affectedRecords: { ...value.affectedRecords },
current: { ...value.current },
expected: {
lifecycleState: value.expected.lifecycleState,
revisionNumber: value.expected.revisionNumber,
durableEffects: [...value.expected.durableEffects],
unavailableEffects: [...value.expected.unavailableEffects],
},
rollback: {
supported: false,
boundary: 'approval_does_not_apply_memory_effects',
},
previewExpiresAt: value.previewExpiresAt,
},
};
}

function normalizeMemoryRejectionPreview(value, selectedReview, selectedDetail, now = Date.now()) {
if (!exactObject(value, APPROVAL_PREVIEW_KEYS)
|| !exactObject(value.scope, APPROVAL_SCOPE_KEYS)
|| !exactObject(value.affectedRecords, APPROVAL_AFFECTED_KEYS)
|| !exactObject(value.current, APPROVAL_CURRENT_KEYS)
|| !exactObject(value.expected, APPROVAL_EXPECTED_KEYS)
|| !exactObject(value.rollback, APPROVAL_ROLLBACK_KEYS)
|| value.action !== 'memory.maintenance.review.reject'
|| !REVIEW_SCOPE_KINDS.includes(value.scope.scopeKind)
|| !REFERENCE_PATTERN.test(value.scope.fingerprint)
|| !REVIEW_KINDS.includes(value.proposalKind)
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| !REVIEW_EFFECTS.includes(value.proposedEffect)
|| REVIEW_EFFECT_BY_KIND[value.proposalKind] !== value.proposedEffect
|| !safeCount(value.affectedRecords.count)
|| value.affectedRecords.count === 0
|| !FINGERPRINT_PATTERN.test(value.affectedRecords.fingerprint)
|| value.current.lifecycleState !== 'pending_review'
|| !safeCount(value.current.revisionNumber)
|| value.current.revisionNumber === 0
|| value.expected.lifecycleState !== 'rejected'
|| !safeCount(value.expected.revisionNumber)
|| value.expected.revisionNumber !== value.current.revisionNumber + 1
|| !exactList(value.expected.durableEffects, APPROVAL_DURABLE_EFFECTS)
|| !exactList(value.expected.unavailableEffects, APPROVAL_UNAVAILABLE_EFFECTS)
|| value.rollback.supported !== false
|| value.rollback.boundary !== 'rejection_does_not_apply_memory_effects'
|| !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt)
|| value.previewExpiresAt < 0
|| !Number.isFinite(new Date(value.previewExpiresAt).getTime())
|| !FINGERPRINT_PATTERN.test(value.previewDigest)) return { state: 'malformed' };
const detail = normalizeMemoryReviewDetail(selectedDetail);
if (!detail
|| !selectedReview
|| !reviewSummariesAgree(detail, selectedReview)
|| !REFERENCE_PATTERN.test(selectedReview.scopeFingerprint)
|| !Number.isSafeInteger(selectedReview.scopeExpiresAt)
|| selectedReview.scopeExpiresAt < 0
|| value.scope.scopeKind !== detail.scopeKind
|| value.scope.fingerprint !== selectedReview.scopeFingerprint
|| value.proposalKind !== detail.kind
|| value.proposalRef !== detail.proposalRef
|| value.proposedEffect !== detail.effectType
|| value.affectedRecords.count !== detail.candidateCount
|| value.affectedRecords.fingerprint !== detail.candidateFingerprint
|| value.current.lifecycleState !== detail.lifecycleState
|| value.current.revisionNumber !== detail.currentRevisionNumber
|| value.previewExpiresAt > selectedReview.handleExpiresAt
|| value.previewExpiresAt > selectedReview.scopeExpiresAt
|| value.previewExpiresAt <= now) return { state: 'stale' };
return {
state: 'populated',
preview: {
action: 'memory.maintenance.review.reject',
scope: { ...value.scope },
proposalKind: value.proposalKind,
proposalRef: value.proposalRef,
proposedEffect: value.proposedEffect,
affectedRecords: { ...value.affectedRecords },
current: { ...value.current },
expected: {
lifecycleState: value.expected.lifecycleState,
revisionNumber: value.expected.revisionNumber,
durableEffects: [...value.expected.durableEffects],
unavailableEffects: [...value.expected.unavailableEffects],
},
rollback: {
supported: false,
boundary: 'rejection_does_not_apply_memory_effects',
},
previewExpiresAt: value.previewExpiresAt,
},
};
}

function normalizeMemoryApplicationPreview(value, selectedReview, selectedDetail, retainedMemoryRef, now = Date.now()) {
if (!exactObject(value, APPLICATION_PREVIEW_KEYS)
|| !exactObject(value.scope, APPROVAL_SCOPE_KEYS)
|| !exactObject(value.affectedRecords, APPLICATION_AFFECTED_KEYS)
|| !exactObject(value.selection, APPLICATION_SELECTION_KEYS, ['retainedMemoryRef'])
|| !exactObject(value.current, APPROVAL_CURRENT_KEYS)
|| !exactObject(value.expected, APPLICATION_EXPECTED_KEYS)
|| !exactObject(value.rollback, APPROVAL_ROLLBACK_KEYS)
|| value.action !== 'memory.maintenance.apply'
|| !REVIEW_SCOPE_KINDS.includes(value.scope.scopeKind)
|| !REFERENCE_PATTERN.test(value.scope.fingerprint)
|| !REVIEW_KINDS.includes(value.proposalKind)
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| REVIEW_EFFECT_BY_KIND[value.proposalKind] !== value.proposedEffect
|| !safeCount(value.affectedRecords.count)
|| value.affectedRecords.count === 0
|| !FINGERPRINT_PATTERN.test(value.affectedRecords.fingerprint)
|| !Array.isArray(value.affectedRecords.roles)
|| value.affectedRecords.roles.length < 1
|| value.affectedRecords.roles.length > 2
|| value.current.lifecycleState !== 'approved'
|| !safeCount(value.current.revisionNumber)
|| value.expected.lifecycleState !== 'applied'
|| value.expected.revisionNumber !== value.current.revisionNumber + 1
|| !exactList(value.expected.durableEffects, APPLICATION_DURABLE_EFFECTS)
|| !exactList(value.expected.retrievalConsequences, value.proposalKind === 'decay'
? ['disabled_records_excluded'] : ['superseded_records_excluded'])
|| value.rollback.supported !== true
|| value.rollback.boundary !== 'separate_confirmation_required'
|| !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt)
|| !FINGERPRINT_PATTERN.test(value.previewDigest)) return { state: 'malformed' };
const roles = value.affectedRecords.roles.map((role) => {
if (!exactObject(role, APPLICATION_ROLE_KEYS)
|| !['retained', 'superseded', 'disabled'].includes(role.role)
|| !safeCount(role.count)
|| role.count === 0
|| !FINGERPRINT_PATTERN.test(role.fingerprint)) return null;
return { ...role };
});
const expectedRoles = value.proposalKind === 'decay'
? ['disabled'] : ['retained', 'superseded'];
if (roles.some((role) => role === null)
|| !exactList(roles.map((role) => role.role), expectedRoles)
|| roles.reduce((sum, role) => sum + role.count, 0) !== value.affectedRecords.count
|| value.selection.required !== (value.proposalKind === 'conflict')
|| (value.proposalKind === 'conflict'
? (!REFERENCE_PATTERN.test(value.selection.retainedMemoryRef)
|| value.selection.retainedMemoryRef !== retainedMemoryRef)
: Object.hasOwn(value.selection, 'retainedMemoryRef'))) return { state: 'malformed' };
const detail = normalizeMemoryReviewDetail(selectedDetail);
if (!detail
|| !selectedReview
|| !reviewSummariesAgree(detail, selectedReview)
|| detail.lifecycleState !== 'approved'
|| value.scope.scopeKind !== detail.scopeKind
|| value.scope.fingerprint !== selectedReview.scopeFingerprint
|| value.proposalKind !== detail.kind
|| value.proposalRef !== detail.proposalRef
|| value.proposedEffect !== detail.effectType
|| value.affectedRecords.count !== detail.candidateCount
|| value.affectedRecords.fingerprint !== detail.candidateFingerprint
|| value.current.revisionNumber !== detail.currentRevisionNumber
|| (value.proposalKind === 'conflict'
&& !detail.candidates.some((candidate) => candidate.memoryRef === retainedMemoryRef))
|| value.previewExpiresAt > selectedReview.handleExpiresAt
|| value.previewExpiresAt > selectedReview.scopeExpiresAt
|| value.previewExpiresAt <= now) return { state: 'stale' };
return {
state: 'populated',
preview: {
action: value.action,
proposalKind: value.proposalKind,
proposalRef: value.proposalRef,
proposedEffect: value.proposedEffect,
affectedRecords: { ...value.affectedRecords, roles },
selection: { ...value.selection },
current: { ...value.current },
expected: { ...value.expected, durableEffects: [...value.expected.durableEffects], retrievalConsequences: [...value.expected.retrievalConsequences] },
rollback: { ...value.rollback },
previewExpiresAt: value.previewExpiresAt,
},
};
}

function normalizeMemoryApprovalConfirmation(value, expected) {
if (!exactObject(value, APPROVAL_CONFIRMATION_KEYS)
|| !exactObject(value.current, APPROVAL_CONFIRMATION_CURRENT_KEYS)
|| !exactObject(value.evidence, APPROVAL_CONFIRMATION_EVIDENCE_KEYS)
|| !exactObject(value.rollback, APPROVAL_ROLLBACK_KEYS)
|| !exactObject(expected, APPROVAL_CONFIRMATION_EXPECTATION_KEYS)
|| value.action !== 'memory.maintenance.review.approve'
|| value.outcome !== 'approved'
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| !REFERENCE_PATTERN.test(expected.proposalRef)
|| value.proposalRef !== expected.proposalRef
|| value.current.lifecycleState !== 'approved'
|| !Number.isSafeInteger(value.current.revisionNumber)
|| value.current.revisionNumber < 2
|| !Number.isSafeInteger(expected.expectedRevisionNumber)
|| expected.expectedRevisionNumber < 2
|| value.current.revisionNumber !== expected.expectedRevisionNumber
|| value.evidence.transition !== 'approve'
|| !REFERENCE_PATTERN.test(value.evidence.revisionRef)
|| !REFERENCE_PATTERN.test(value.evidence.auditRef)
|| value.memoryRecordMutation !== false
|| value.rollback.supported !== false
|| value.rollback.boundary !== 'approval_does_not_apply_memory_effects') {
return { state: 'malformed' };
}
return {
state: 'succeeded',
result: {
action: 'memory.maintenance.review.approve',
outcome: 'approved',
proposalRef: value.proposalRef,
current: {
lifecycleState: 'approved',
revisionNumber: value.current.revisionNumber,
},
evidence: {
transition: 'approve',
revisionRef: value.evidence.revisionRef,
auditRef: value.evidence.auditRef,
},
memoryRecordMutation: false,
rollback: {
supported: false,
boundary: 'approval_does_not_apply_memory_effects',
},
},
};
}

function normalizeMemoryRejectionConfirmation(value, expected) {
if (!exactObject(value, APPROVAL_CONFIRMATION_KEYS)
|| !exactObject(value.current, APPROVAL_CONFIRMATION_CURRENT_KEYS)
|| !exactObject(value.evidence, APPROVAL_CONFIRMATION_EVIDENCE_KEYS)
|| !exactObject(value.rollback, APPROVAL_ROLLBACK_KEYS)
|| !exactObject(expected, APPROVAL_CONFIRMATION_EXPECTATION_KEYS)
|| value.action !== 'memory.maintenance.review.reject'
|| value.outcome !== 'rejected'
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| !REFERENCE_PATTERN.test(expected.proposalRef)
|| value.proposalRef !== expected.proposalRef
|| value.current.lifecycleState !== 'rejected'
|| !Number.isSafeInteger(value.current.revisionNumber)
|| value.current.revisionNumber < 2
|| !Number.isSafeInteger(expected.expectedRevisionNumber)
|| expected.expectedRevisionNumber < 2
|| value.current.revisionNumber !== expected.expectedRevisionNumber
|| value.evidence.transition !== 'reject'
|| !REFERENCE_PATTERN.test(value.evidence.revisionRef)
|| !REFERENCE_PATTERN.test(value.evidence.auditRef)
|| value.memoryRecordMutation !== false
|| value.rollback.supported !== false
|| value.rollback.boundary !== 'rejection_does_not_apply_memory_effects') {
return { state: 'malformed' };
}
return {
state: 'succeeded',
result: {
action: 'memory.maintenance.review.reject',
outcome: 'rejected',
proposalRef: value.proposalRef,
current: {
lifecycleState: 'rejected',
revisionNumber: value.current.revisionNumber,
},
evidence: {
transition: 'reject',
revisionRef: value.evidence.revisionRef,
auditRef: value.evidence.auditRef,
},
memoryRecordMutation: false,
rollback: {
supported: false,
boundary: 'rejection_does_not_apply_memory_effects',
},
},
};
}

function createElement(tag, attributes = {}, text) {
const element = document.createElement(tag);
for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
if (text !== undefined) element.textContent = text;
return element;
}

function append(parent, tag, attributes = {}, text) {
const element = createElement(tag, attributes, text);
parent.append(element);
return element;
}

function lines(cell, lines) {
for (const [className, text] of lines) append(cell, 'span', { class: className }, text);
}

function detailTable(parent, caption, headings, bodyAttributes = {}) {
const table = append(parent, 'table', {
class: 'worker-heartbeats-table jobs-table',
role: 'table',
});
append(table, 'caption', { class: 'sr-only' }, caption);
const headingRow = append(append(table, 'thead'), 'tr');
for (const heading of headings) append(headingRow, 'th', { scope: 'col' }, heading);
return append(table, 'tbody', bodyAttributes);
}

function detailRow(list, cells) {
const row = append(list, 'tr');
for (const [label, cellLines] of cells) {
const cell = append(row, 'td', { 'data-label': label });
lines(cell, cellLines);
}
}

function formatDate(value) {
return new Intl.DateTimeFormat(undefined, {
dateStyle: 'medium',
timeStyle: 'short',
}).format(new Date(value));
}

function valueLabel(value) {
const label = value.replaceAll('_', ' ');
return label.charAt(0).toUpperCase() + label.slice(1);
}

function renderMemoryRecords(page, elements) {
elements.list.replaceChildren();
for (const [index, record] of page.entries.entries()) {
const row = append(elements.list, 'tr');
const memory = append(row, 'td', { 'data-label': 'Memory' });
const signals = [];
if (record.textHidden) signals.push('Text hidden');
if (record.titleRedacted || record.contentRedacted) signals.push('Redacted');
if (record.titleTruncated || record.contentTruncated) signals.push('Preview truncated');
lines(memory, [
[PRIMARY, record.title],
[SECONDARY, record.contentPreview],
[SECONDARY, 'Record: ' + record.recordRef],
...(signals.length ? [[REDACTION, signals.join(' / ')]] : []),
]);
if (Object.hasOwn(elements, 'selectedRecordRef')) append(memory, 'button', {
class: 'button button-secondary memory-record-detail-button',
type: 'button',
'data-record-index': String(index),
'aria-controls': 'memory-record-detail',
'aria-expanded': record.recordRef === elements.selectedRecordRef ? 'true' : 'false',
}, 'View provenance');
const lifecycle = append(row, 'td', { 'data-label': 'Lifecycle' });
lines(lifecycle, [
['memory-state memory-state-' + record.state, valueLabel(record.state)],
[SECONDARY, 'Kind: ' + valueLabel(record.kind)],
[SECONDARY, 'Scope: ' + valueLabel(record.scopeKind)],
]);
const governance = append(row, 'td', { 'data-label': 'Governance' });
lines(governance, [
[PRIMARY, valueLabel(record.visibility)],
[SECONDARY, 'Sensitivity: ' + valueLabel(record.sensitivity)],
[SECONDARY, 'Authority: ' + valueLabel(record.authority)],
]);
const evidence = append(row, 'td', { 'data-label': 'Evidence' });
lines(evidence, [
[PRIMARY_NUMBER,
'Confidence: ' + Math.round(record.confidence * 100) + '%'],
[SECONDARY_NUMBER,
'Importance: ' + Math.round(record.importance * 100) + '%'],
[SECONDARY_NUMBER,
'Sources: ' + record.sourceCount + ' / Revisions: ' + record.revisionCount],
]);
const dates = append(row, 'td', { 'data-label': 'Dates' });
lines(dates, [
[PRIMARY, 'Updated: ' + formatDate(record.updatedAt)],
[SECONDARY, 'Created: ' + formatDate(record.createdAt)],
[SECONDARY, record.expiresAt
? 'Expires: ' + formatDate(record.expiresAt)
: 'No expiry'],
]);
}
}

function renderMemoryRecordDetail(value, selectedRecord, elements) {
const detail = normalizeMemoryRecordDetail(value);
if (!detail) return 'malformed';
if (!recordSummariesAgree(detail, selectedRecord)) return 'stale';
renderMemoryRecords({ entries: [detail.record] }, { list: elements.record });
elements.sources.replaceChildren();
elements.revisions.replaceChildren();
elements.audit.replaceChildren();
for (const source of detail.sources) detailRow(elements.sources, [
['Source', [
[PRIMARY, valueLabel(source.sourceType)],
[SECONDARY, 'Source: ' + source.sourceRef],
]],
['Resolution', [[
PRIMARY, valueLabel(source.resolutionState),
]]],
['Extractor', [[
PRIMARY, valueLabel(source.extractorClass),
]]],
['Timestamp', [[
PRIMARY, formatDate(source.sourceTimestamp),
]]],
]);
for (const revision of detail.revisions) {
const lifecycle = revision.previousLifecycleState
? valueLabel(revision.previousLifecycleState) + ' to '
+ (revision.newLifecycleState ? valueLabel(revision.newLifecycleState) : 'Hidden')
: revision.newLifecycleState
? 'To ' + valueLabel(revision.newLifecycleState)
: 'Lifecycle hidden';
const signals = [];
if (revision.reasonRedacted) signals.push('Reason redacted');
if (revision.reasonTruncated) signals.push('Reason truncated');
detailRow(elements.revisions, [
['Revision', [
[PRIMARY_NUMBER, 'Revision ' + revision.revisionNumber],
[SECONDARY, 'Revision: ' + revision.revisionRef],
]],
['Change', [
[PRIMARY, valueLabel(revision.changeType)],
[SECONDARY, 'Actor: ' + valueLabel(revision.actorClass)],
]],
['Lifecycle', [[
PRIMARY, lifecycle,
]]],
['Evidence', [
[PRIMARY, formatDate(revision.createdAt)],
[SECONDARY, revision.evaluatorLinked ? 'Evaluator linked' : 'No evaluator link'],
...(Object.hasOwn(revision, 'reason')
? [[SECONDARY, 'Reason: ' + revision.reason]]
: [[SECONDARY, 'No reason']]),
...(signals.length ? [[REDACTION, signals.join(' / ')]] : []),
]],
]);
}
for (const entry of detail.audit) {
const signals = [];
if (entry.summaryRedacted) signals.push('Summary redacted');
if (entry.summaryTruncated) signals.push('Summary truncated');
detailRow(elements.audit, [
['Event', [
[PRIMARY, entry.eventType],
[SECONDARY, 'Audit: ' + entry.auditRef],
]],
['Summary', [
[PRIMARY, entry.summary],
...(signals.length ? [[REDACTION, signals.join(' / ')]] : []),
]],
['Risk', [
[PRIMARY, valueLabel(entry.level)],
[SECONDARY, entry.riskLevel
? 'Risk: ' + valueLabel(entry.riskLevel)
: 'Risk not classified'],
]],
['Evidence', [
[PRIMARY, formatDate(entry.timestamp)],
[SECONDARY, entry.evaluatorLinked ? 'Evaluator linked' : 'No evaluator link'],
[SECONDARY, 'Details hidden'],
]],
]);
}
elements.sourceCount.textContent = 'Showing ' + detail.sources.length + ' of '
+ detail.record.sourceCount + (detail.sourcesTruncated ? ' sources - truncated' : ' sources');
elements.revisionCount.textContent = 'Showing ' + detail.revisions.length + ' of '
+ detail.record.revisionCount + (detail.revisionsTruncated ? ' revisions - truncated' : ' revisions');
elements.auditCount.textContent = 'Showing ' + detail.audit.length
+ (detail.audit.length === 1 ? ' audit entry' : ' audit entries')
+ (detail.auditTruncated ? ' - truncated' : '');
return 'content';
}

function renderMemoryReviews(page, elements) {
elements.list.replaceChildren();
for (const [index, review] of page.entries.entries()) {
const row = append(elements.list, 'tr');
const proposal = append(row, 'td', { 'data-label': 'Proposal' });
lines(proposal, [
[PRIMARY, valueLabel(review.kind)],
[SECONDARY, 'Proposal: ' + review.proposalRef],
[SECONDARY, 'Effect: ' + valueLabel(review.effectType)],
]);
append(proposal, 'button', {
class: 'button button-secondary memory-review-detail-button',
type: 'button',
'data-review-index': String(index),
'aria-controls': 'memory-review-detail',
'aria-expanded': review.proposalRef === elements.selectedReviewRef ? 'true' : 'false',
}, 'View details');
const lifecycle = append(row, 'td', { 'data-label': 'Lifecycle' });
lines(lifecycle, [
['memory-state memory-state-' + review.lifecycleState,
valueLabel(review.lifecycleState)],
[SECONDARY, 'Scope: ' + valueLabel(review.scopeKind)],
[SECONDARY_NUMBER,
'Revision: ' + review.currentRevisionNumber + ' / ' + review.revisionCount],
]);
const candidates = append(row, 'td', { 'data-label': 'Candidates' });
lines(candidates, [
[PRIMARY_NUMBER, 'Count: ' + review.candidateCount],
[SECONDARY, review.reasonCodes.length
? 'Reasons: ' + review.reasonCodes.map(valueLabel).join(' / ')
: 'No reason codes'],
]);
const confidence = append(row, 'td', { 'data-label': 'Confidence' });
lines(confidence, [[
PRIMARY_NUMBER,
Math.round(review.confidence * 100) + '%',
]]);
const dates = append(row, 'td', { 'data-label': 'Dates' });
lines(dates, [
[PRIMARY, 'Updated: ' + formatDate(review.updatedAt)],
[SECONDARY, 'Created: ' + formatDate(review.createdAt)],
[SECONDARY, review.expiresAt
? 'Proposal expires: ' + formatDate(review.expiresAt)
: 'No proposal expiry'],
[SECONDARY, 'Access expires: ' + formatDate(review.handleExpiresAt)],
]);
}
}

function renderMemoryReviewDetail(value, selectedReview, elements) {
const detail = normalizeMemoryReviewDetail(value);
if (!detail) return 'malformed';
if (!reviewSummariesAgree(detail, selectedReview)) return 'stale';
elements.summary.replaceChildren();
elements.candidates.replaceChildren();
elements.revisions.replaceChildren();
const row = append(elements.summary, 'tr');
const proposal = append(row, 'td', { 'data-label': 'Proposal' });
lines(proposal, [
[PRIMARY, valueLabel(detail.kind)],
[SECONDARY, 'Proposal: ' + detail.proposalRef],
[SECONDARY, 'Effect: ' + valueLabel(detail.effectType)],
]);
const lifecycle = append(row, 'td', { 'data-label': 'Lifecycle' });
lines(lifecycle, [
['memory-state memory-state-' + detail.lifecycleState, valueLabel(detail.lifecycleState)],
[SECONDARY, 'Scope: ' + valueLabel(detail.scopeKind)],
[SECONDARY_NUMBER,
'Revision: ' + detail.currentRevisionNumber + ' / ' + detail.revisionCount],
]);
const effect = append(row, 'td', { 'data-label': 'Effect' });
lines(effect, [
[PRIMARY, detail.effectMemoryRole
? valueLabel(detail.effectMemoryRole)
: 'No fixed effect role'],
[SECONDARY, detail.effectMemoryRef
? 'Memory: ' + detail.effectMemoryRef
: 'No effect memory'],
]);
const evidence = append(row, 'td', { 'data-label': 'Evidence' });
lines(evidence, [
[PRIMARY_NUMBER,
'Confidence: ' + Math.round(detail.confidence * 100) + '%'],
[SECONDARY, detail.reasonCodes.length
? 'Reasons: ' + detail.reasonCodes.map(valueLabel).join(' / ')
: 'No reason codes'],
]);
const dates = append(row, 'td', { 'data-label': 'Dates' });
lines(dates, [
[PRIMARY, 'Updated: ' + formatDate(detail.updatedAt)],
[SECONDARY, 'Created: ' + formatDate(detail.createdAt)],
[SECONDARY, detail.expiresAt
? 'Expires: ' + formatDate(detail.expiresAt)
: 'No expiry'],
]);
for (const candidate of detail.candidates) {
const candidateRow = append(elements.candidates, 'tr');
const identity = append(candidateRow, 'td', { 'data-label': 'Candidate' });
lines(identity, [
[PRIMARY_NUMBER,
'Candidate ' + (candidate.candidateOrdinal + 1)],
[SECONDARY, 'Memory: ' + candidate.memoryRef],
]);
const role = append(candidateRow, 'td', { 'data-label': 'Role' });
lines(role, [
[PRIMARY, valueLabel(candidate.effectRole)],
[SECONDARY, 'Expected: ' + valueLabel(candidate.expectedState)],
]);
const record = append(candidateRow, 'td', { 'data-label': 'Record evidence' });
lines(record, [[
SECONDARY,
'Record evidence validated',
]]);
const source = append(candidateRow, 'td', { 'data-label': 'Source evidence' });
lines(source, [
[PRIMARY_NUMBER, 'Sources: ' + candidate.sourceCount],
[SECONDARY, 'Source evidence bounded'],
]);
}
for (const revision of detail.revisions) {
const revisionRow = append(elements.revisions, 'tr');
const number = append(revisionRow, 'td', { 'data-label': 'Revision' });
lines(number, [[
PRIMARY_NUMBER,
'Revision ' + revision.revisionNumber,
]]);
const transition = append(revisionRow, 'td', { 'data-label': 'Transition' });
lines(transition, [
[PRIMARY, valueLabel(revision.transition)],
[SECONDARY, revision.previousState
? valueLabel(revision.previousState) + ' to ' + valueLabel(revision.newState)
: 'Initial ' + valueLabel(revision.newState)],
]);
const actor = append(revisionRow, 'td', { 'data-label': 'Actor' });
lines(actor, [
[PRIMARY, valueLabel(revision.actorClass)],
[SECONDARY, valueLabel(revision.invocationContext)],
]);
const revisionEvidence = append(revisionRow, 'td', { 'data-label': 'Evidence' });
lines(revisionEvidence, [
[PRIMARY, formatDate(revision.createdAt)],
[SECONDARY, 'Reason: ' + revision.reasonCode],
]);
}
elements.candidateCount.textContent = 'Showing ' + detail.candidates.length + ' of '
+ detail.candidateCount + (detail.candidatesTruncated ? ' candidates - truncated' : ' candidates');
elements.revisionCount.textContent = 'Showing ' + detail.revisions.length + ' of '
+ detail.revisionCount + (detail.revisionsTruncated ? ' revisions - latest only' : ' revisions');
return 'content';
}

function renderMemoryApprovalPreview(value, selectedReview, selectedDetail, elements, now) {
const normalized = normalizeMemoryApprovalPreview(value, selectedReview, selectedDetail, now);
if (normalized.state !== 'populated') return normalized;
const preview = normalized.preview;
elements.evidence.replaceChildren();
detailRow(elements.evidence, [
['Action', [
[PRIMARY, 'Approve review'],
[SECONDARY, 'Proposal: ' + preview.proposalRef],
[SECONDARY, 'Kind: ' + valueLabel(preview.proposalKind)],
]],
['Effect', [
[PRIMARY, valueLabel(preview.proposedEffect)],
[SECONDARY_NUMBER, 'Affected records: ' + preview.affectedRecords.count],
]],
['Transition', [
[PRIMARY, valueLabel(preview.current.lifecycleState)
+ ' at revision ' + preview.current.revisionNumber],
[SECONDARY, valueLabel(preview.expected.lifecycleState)
+ ' at revision ' + preview.expected.revisionNumber],
[SECONDARY, 'Durable: ' + preview.expected.durableEffects.map(valueLabel).join(' / ')],
[SECONDARY, 'Unavailable: '
+ preview.expected.unavailableEffects.map(valueLabel).join(' / ')],
]],
['Rollback', [
[PRIMARY, 'Direct rollback unavailable'],
[SECONDARY, valueLabel(preview.rollback.boundary)],
[SECONDARY, 'Preview expires: ' + formatDate(preview.previewExpiresAt)],
]],
]);
return normalized;
}

function renderMemoryRejectionPreview(value, selectedReview, selectedDetail, elements, now) {
const normalized = normalizeMemoryRejectionPreview(value, selectedReview, selectedDetail, now);
if (normalized.state !== 'populated') return normalized;
const preview = normalized.preview;
elements.evidence.replaceChildren();
detailRow(elements.evidence, [
['Action', [
[PRIMARY, 'Reject review'],
[SECONDARY, 'Proposal: ' + preview.proposalRef],
[SECONDARY, 'Kind: ' + valueLabel(preview.proposalKind)],
]],
['Effect', [
[PRIMARY, valueLabel(preview.proposedEffect)],
[SECONDARY_NUMBER, 'Affected records: ' + preview.affectedRecords.count],
]],
['Transition', [
[PRIMARY, valueLabel(preview.current.lifecycleState)
+ ' at revision ' + preview.current.revisionNumber],
[SECONDARY, valueLabel(preview.expected.lifecycleState)
+ ' at revision ' + preview.expected.revisionNumber],
[SECONDARY, 'Durable: ' + preview.expected.durableEffects.map(valueLabel).join(' / ')],
[SECONDARY, 'Unavailable: '
+ preview.expected.unavailableEffects.map(valueLabel).join(' / ')],
]],
['Rollback', [
[PRIMARY, 'Direct rollback unavailable'],
[SECONDARY, valueLabel(preview.rollback.boundary)],
[SECONDARY, 'Preview expires: ' + formatDate(preview.previewExpiresAt)],
]],
]);
return normalized;
}

function createMemoryApplicationPreview(parent) {
const section = append(parent, 'section', {
id: 'memory-review-application-preview',
'aria-labelledby': 'memory-review-application-preview-title',
});
const header = append(section, 'header', { class: 'view-toolbar activity-panel-toolbar' });
const title = append(header, 'div');
append(title, 'p', { class: 'eyebrow' }, 'Write-free operation');
append(title, 'h3', { id: 'memory-review-application-preview-title' }, 'Application preview');
const button = append(header, 'button', {
id: 'memory-review-application-preview-button', class: 'button button-primary', type: 'button', disabled: '', 'aria-controls': 'memory-review-application-preview-populated',
}, 'Preview application');
const selection = append(section, 'div', { id: 'memory-review-application-selection', hidden: '' });
append(selection, 'label', { for: 'memory-review-retained-memory-select' }, 'Retained conflict candidate');
const retainedSelect = append(selection, 'select', {
id: 'memory-review-retained-memory-select', disabled: '',
});
append(retainedSelect, 'option', { value: '' }, 'Select a retained memory');
const state = (id, className, role, heading, description) => {
const element = append(section, 'section', { id, class: className, role, hidden: '' });
append(element, 'h2', {}, heading);
append(element, 'p', {}, description);
return element;
};
const unrequested = state('memory-review-application-preview-unrequested', 'empty-band', 'status',
'Application preview not requested', 'No current application preview is loaded.');
const loading = state('memory-review-application-preview-loading', 'empty-band', 'status',
'Loading application preview', 'Current memory effects are being prepared.');
const malformed = state('memory-review-application-preview-malformed', 'error-band', 'alert',
'Application preview malformed', 'Refresh the Review queue before requesting another preview.');
const unavailable = state('memory-review-application-preview-unavailable', 'error-band', 'alert',
'Application preview unavailable', 'Request the preview again.');
const notFound = state('memory-review-application-preview-not-found', 'error-band', 'alert',
'Application preview not found', 'Refresh the Review queue for current access.');
const stale = state('memory-review-application-preview-stale', 'error-band', 'alert',
'Application preview changed', 'Refresh the Review queue before continuing.');
const populated = append(section, 'div', {
id: 'memory-review-application-preview-populated', class: 'worker-heartbeats-content', hidden: '',
});
const evidence = detailTable(populated, 'Memory maintenance application preview',
['Action', 'Effect', 'Transition', 'Rollback'], { id: 'memory-review-application-preview-evidence' });
return { button, selection, retainedSelect, evidence,
states: [unrequested, loading, malformed, unavailable, notFound, stale, populated] };
}

function renderMemoryApplicationPreview(value, selectedReview, selectedDetail, retainedMemoryRef, elements, now) {
const normalized = normalizeMemoryApplicationPreview(
value,
selectedReview,
selectedDetail,
retainedMemoryRef,
now,
);
if (normalized.state !== 'populated') return normalized;
const preview = normalized.preview;
elements.evidence.replaceChildren();
detailRow(elements.evidence, [
['Action', [
[PRIMARY, 'Apply ' + valueLabel(preview.proposalKind)],
[SECONDARY, 'Proposal: ' + preview.proposalRef],
]],
['Effect', [
[PRIMARY, valueLabel(preview.proposedEffect)],
[SECONDARY_NUMBER, 'Affected: ' + preview.affectedRecords.count],
[SECONDARY, preview.affectedRecords.roles.map((role) => valueLabel(role.role) + ': ' + role.count).join(' / ')],
]],
['Transition', [
[PRIMARY, valueLabel(preview.current.lifecycleState) + ' → ' + valueLabel(preview.expected.lifecycleState)],
[SECONDARY_NUMBER, 'Revision: ' + preview.current.revisionNumber + ' → ' + preview.expected.revisionNumber],
[SECONDARY, preview.expected.retrievalConsequences.map(valueLabel).join(' / ')],
]],
['Rollback', [
[PRIMARY, 'Supported'],
[SECONDARY, valueLabel(preview.rollback.boundary)],
]],
]);
return normalized;
}

function renderMemoryApprovalConfirmation(value, expected, elements) {
const normalized = normalizeMemoryApprovalConfirmation(value, expected);
if (normalized.state !== 'succeeded') return normalized;
const result = normalized.result;
elements.evidence.replaceChildren();
detailRow(elements.evidence, [
['Outcome', [
[PRIMARY, 'Approved'],
[SECONDARY, 'Proposal: ' + result.proposalRef],
[SECONDARY_NUMBER, 'Revision: ' + result.current.revisionNumber],
]],
['Transition evidence', [
[PRIMARY, valueLabel(result.evidence.transition)],
[SECONDARY, 'Revision: ' + result.evidence.revisionRef],
[SECONDARY, 'Audit: ' + result.evidence.auditRef],
]],
['Memory effect', [
[PRIMARY, 'Memory records unchanged'],
[SECONDARY, 'Approval does not apply memory effects'],
]],
['Rollback', [
[PRIMARY, 'Direct rollback unavailable'],
[SECONDARY, valueLabel(result.rollback.boundary)],
]],
]);
return normalized;
}

function renderMemoryRejectionConfirmation(value, expected, elements) {
const normalized = normalizeMemoryRejectionConfirmation(value, expected);
if (normalized.state !== 'succeeded') return normalized;
const result = normalized.result;
elements.evidence.replaceChildren();
detailRow(elements.evidence, [
['Outcome', [
[PRIMARY, 'Rejected'],
[SECONDARY, 'Proposal: ' + result.proposalRef],
[SECONDARY_NUMBER, 'Revision: ' + result.current.revisionNumber],
]],
['Transition evidence', [
[PRIMARY, valueLabel(result.evidence.transition)],
[SECONDARY, 'Revision: ' + result.evidence.revisionRef],
[SECONDARY, 'Audit: ' + result.evidence.auditRef],
]],
['Memory effect', [
[PRIMARY, 'Memory records unchanged'],
[SECONDARY, 'Rejection does not apply memory effects'],
]],
['Rollback', [
[PRIMARY, 'Direct rollback unavailable'],
[SECONDARY, valueLabel(result.rollback.boundary)],
]],
]);
return normalized;
}

export {
append,
createElement,
createMemoryApplicationPreview,
detailTable,
normalizeMemoryApplicationPreview,
normalizeMemoryApprovalConfirmation,
normalizeMemoryApprovalPreview,
normalizeMemoryRejectionConfirmation,
normalizeMemoryRejectionPreview,
normalizeMemoryRecordPage,
normalizeMemoryReviewPage,
normalizeMemoryReviewScopeCatalog,
normalizeMemoryScopeCatalog,
renderMemoryApplicationPreview,
renderMemoryApprovalConfirmation,
renderMemoryApprovalPreview,
renderMemoryRejectionConfirmation,
renderMemoryRejectionPreview,
renderMemoryRecordDetail,
renderMemoryRecords,
renderMemoryReviewDetail,
renderMemoryReviews,
};
