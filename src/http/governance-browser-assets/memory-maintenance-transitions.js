import { append, detailTable } from '/governance/memory-presentation.js';

const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_KINDS = ['global', 'user', 'group', 'conversation', 'system'];
const EFFECT_BY_KIND = {
conflict: 'resolve_conflict',
consolidation: 'consolidate',
decay: 'disable',
};
const COMMON_DURABLE_EFFECTS = [
'proposal_state_transition',
'proposal_revision_append',
'audit_event_append',
];
const ROLLBACK_DURABLE_EFFECTS = [
...COMMON_DURABLE_EFFECTS,
'memory_record_revision_append',
'proposal_effect_evidence_append',
];

function exactObject(value, required, optional = []) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
const keys = Object.keys(value);
return required.every((key) => Object.hasOwn(value, key))
&& keys.every((key) => required.includes(key) || optional.includes(key));
}

function exactList(value, expected) {
return Array.isArray(value)
&& value.length === expected.length
&& value.every((entry, index) => entry === expected[index]);
}

function safeCount(value) {
return Number.isSafeInteger(value) && value >= 0;
}

function validScope(value) {
return exactObject(value, ['fingerprint', 'scopeKind'], ['conversationType'])
&& REFERENCE_PATTERN.test(value.fingerprint)
&& SCOPE_KINDS.includes(value.scopeKind)
&& (value.scopeKind === 'conversation'
? ['private', 'group'].includes(value.conversationType)
: !Object.hasOwn(value, 'conversationType'));
}

function commonPreviewValid(value, selected, detail, lifecycleState, action, now) {
return validScope(value.scope)
&& value.action === action
&& Object.hasOwn(EFFECT_BY_KIND, value.proposalKind)
&& EFFECT_BY_KIND[value.proposalKind] === value.proposedEffect
&& REFERENCE_PATTERN.test(value.proposalRef)
&& safeCount(value.affectedRecords.count)
&& value.affectedRecords.count > 0
&& FINGERPRINT_PATTERN.test(value.affectedRecords.fingerprint)
&& exactObject(value.current, ['lifecycleState', 'revisionNumber'])
&& value.current.lifecycleState === lifecycleState
&& safeCount(value.current.revisionNumber)
&& OPAQUE_PATTERN.test(value.previewHandle)
&& Number.isSafeInteger(value.previewExpiresAt)
&& value.previewExpiresAt > now
&& FINGERPRINT_PATTERN.test(value.previewDigest)
&& selected
&& detail
&& selected.proposalRef === detail.proposalRef
&& selected.lifecycleState === detail.lifecycleState
&& selected.currentRevisionNumber === detail.currentRevisionNumber
&& value.scope.scopeKind === detail.scopeKind
&& value.scope.fingerprint === selected.scopeFingerprint
&& value.proposalKind === detail.kind
&& value.proposalRef === detail.proposalRef
&& value.proposedEffect === detail.effectType
&& value.affectedRecords.count === detail.candidateCount
&& value.affectedRecords.fingerprint === detail.candidateFingerprint
&& value.current.revisionNumber === detail.currentRevisionNumber
&& value.previewExpiresAt <= selected.handleExpiresAt
&& value.previewExpiresAt <= selected.scopeExpiresAt;
}

function normalizeRollbackPreview(value, selected, detail, now) {
if (!exactObject(value, [
'action', 'scope', 'proposalKind', 'proposalRef', 'proposedEffect',
'affectedRecords', 'current', 'expected', 'confirmation', 'previewDigest',
'previewHandle', 'previewExpiresAt',
])
|| !exactObject(value.affectedRecords, ['count', 'fingerprint', 'roles'])
|| !exactObject(value.expected, [
'lifecycleState', 'revisionNumber', 'durableEffects', 'retrievalConsequences',
])
|| !exactObject(value.confirmation, ['required', 'boundary'])
|| !commonPreviewValid(
value,
selected,
detail,
'applied',
'memory.maintenance.rollback',
now,
)
|| value.expected.lifecycleState !== 'rolled_back'
|| value.expected.revisionNumber !== value.current.revisionNumber + 1
|| !exactList(value.expected.durableEffects, ROLLBACK_DURABLE_EFFECTS)
|| !exactList(value.expected.retrievalConsequences, ['restored_records_included'])
|| value.confirmation.required !== true
|| value.confirmation.boundary !== 'separate_confirmation_required'
|| !Array.isArray(value.affectedRecords.roles)
|| value.affectedRecords.roles.length !== 1) return { state: 'malformed' };
const role = value.affectedRecords.roles[0];
if (!exactObject(role, ['role', 'count', 'fingerprint'])
|| role.role !== 'restored'
|| role.count !== value.affectedRecords.count
|| !FINGERPRINT_PATTERN.test(role.fingerprint)) return { state: 'malformed' };
return {
state: 'populated',
preview: {
action: value.action,
proposalKind: value.proposalKind,
proposalRef: value.proposalRef,
proposedEffect: value.proposedEffect,
affectedRecords: {
count: value.affectedRecords.count,
fingerprint: value.affectedRecords.fingerprint,
roles: [{ ...role }],
},
current: { ...value.current },
expected: {
lifecycleState: value.expected.lifecycleState,
revisionNumber: value.expected.revisionNumber,
durableEffects: [...value.expected.durableEffects],
retrievalConsequences: [...value.expected.retrievalConsequences],
},
confirmation: { ...value.confirmation },
previewExpiresAt: value.previewExpiresAt,
},
};
}

function normalizeExpirationPreview(value, selected, detail, now) {
if (!exactObject(value, [
'action', 'scope', 'proposalKind', 'proposalRef', 'proposedEffect',
'affectedRecords', 'current', 'expected', 'rollback', 'previewDigest',
'previewHandle', 'previewExpiresAt',
])
|| !exactObject(value.affectedRecords, ['count', 'fingerprint'])
|| !exactObject(value.expected, [
'lifecycleState', 'revisionNumber', 'durableEffects', 'unavailableEffects',
])
|| !exactObject(value.rollback, ['supported', 'boundary'])
|| !commonPreviewValid(
value,
selected,
detail,
'pending_review',
'memory.maintenance.review.expire',
now,
)
|| value.expected.lifecycleState !== 'expired'
|| value.expected.revisionNumber !== value.current.revisionNumber + 1
|| !exactList(value.expected.durableEffects, COMMON_DURABLE_EFFECTS)
|| !exactList(value.expected.unavailableEffects, ['memory_record_mutation'])
|| value.rollback.supported !== false
|| value.rollback.boundary !== 'expiration_does_not_apply_memory_effects') {
return { state: 'malformed' };
}
return {
state: 'populated',
preview: {
action: value.action,
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
rollback: { ...value.rollback },
previewExpiresAt: value.previewExpiresAt,
},
};
}

function commonResultValid(value, expected, action, outcome, transition, lifecycleState) {
return REFERENCE_PATTERN.test(value.proposalRef)
&& value.proposalRef === expected.proposalRef
&& value.action === action
&& value.outcome === outcome
&& exactObject(value.current, ['lifecycleState', 'revisionNumber'])
&& value.current.lifecycleState === lifecycleState
&& value.current.revisionNumber === expected.expectedRevisionNumber
&& exactObject(value.evidence, ['transition', 'revisionRef', 'auditRef'])
&& value.evidence.transition === transition
&& REFERENCE_PATTERN.test(value.evidence.revisionRef)
&& REFERENCE_PATTERN.test(value.evidence.auditRef)
&& exactObject(value.rollback, ['supported', 'boundary'])
&& value.rollback.supported === false;
}

function normalizeRollbackResult(value, expected) {
if (!exactObject(value, [
'action', 'outcome', 'proposalKind', 'proposalRef', 'proposedEffect',
'affectedRecords', 'current', 'retrievalConsequences', 'evidence', 'rollback',
])
|| !commonResultValid(
value,
expected,
'memory.maintenance.rollback',
'rolled_back',
'rollback',
'rolled_back',
)
|| value.proposalKind !== expected.proposalKind
|| value.proposedEffect !== expected.proposedEffect
|| !exactObject(value.affectedRecords, ['count', 'fingerprint', 'roles'])
|| value.affectedRecords.count !== expected.affectedRecords.count
|| value.affectedRecords.fingerprint !== expected.affectedRecords.fingerprint
|| !FINGERPRINT_PATTERN.test(value.affectedRecords.fingerprint)
|| !Array.isArray(value.affectedRecords.roles)
|| value.affectedRecords.roles.length !== 1
|| !exactList(value.retrievalConsequences, ['restored_records_included'])
|| value.rollback.boundary !== 'rollback_is_terminal') return null;
const role = value.affectedRecords.roles[0];
const wanted = expected.affectedRecords.roles[0];
if (!exactObject(role, ['role', 'count', 'fingerprint'])
|| role.role !== 'restored'
|| role.role !== wanted.role
|| role.count !== wanted.count
|| role.fingerprint !== wanted.fingerprint
|| !FINGERPRINT_PATTERN.test(role.fingerprint)) return null;
return value;
}

function normalizeExpirationResult(value, expected) {
if (!exactObject(value, [
'action', 'outcome', 'proposalRef', 'current', 'evidence',
'memoryRecordMutation', 'rollback',
])
|| !commonResultValid(
value,
expected,
'memory.maintenance.review.expire',
'expired',
'expire',
'expired',
)
|| value.memoryRecordMutation !== false
|| value.rollback.boundary !== 'expiration_does_not_apply_memory_effects') return null;
return value;
}

function state(parent, id, className, role, title, description) {
const element = append(parent, 'section', { id, class: className, role, hidden: '' });
append(element, 'h3', {}, title);
append(element, 'p', {}, description);
return element;
}

function createSurface(parent, config) {
const section = append(parent, 'section', {
id: 'memory-review-' + config.key + '-preview',
'aria-labelledby': 'memory-review-' + config.key + '-preview-title',
});
const header = append(section, 'header', { class: 'view-toolbar activity-panel-toolbar' });
const title = append(header, 'div');
append(title, 'p', { class: 'eyebrow' }, 'Explicit confirmation required');
append(title, 'h3', { id: 'memory-review-' + config.key + '-preview-title' }, config.title + ' preview');
const button = append(header, 'button', {
id: 'memory-review-' + config.key + '-preview-button',
class: 'button button-primary',
type: 'button',
'aria-controls': 'memory-review-' + config.key + '-preview-populated',
disabled: '',
}, 'Preview ' + config.noun);
const unrequested = state(section, 'memory-review-' + config.key + '-preview-unrequested', 'empty-band', 'status', config.title + ' preview not requested', 'No current ' + config.noun + ' preview is loaded.');
const loading = state(section, 'memory-review-' + config.key + '-preview-loading', 'empty-band', 'status', 'Loading ' + config.noun + ' preview', 'Current effects are being prepared.');
const malformed = state(section, 'memory-review-' + config.key + '-preview-malformed', 'error-band', 'alert', config.title + ' preview malformed', 'Refresh Review before requesting another preview.');
const unavailable = state(section, 'memory-review-' + config.key + '-preview-unavailable', 'error-band', 'alert', config.title + ' preview unavailable', 'Request a fresh preview.');
const notFound = state(section, 'memory-review-' + config.key + '-preview-not-found', 'empty-band', 'status', config.title + ' preview not found', 'Refresh Review before continuing.');
const stale = state(section, 'memory-review-' + config.key + '-preview-stale', 'error-band', 'alert', config.title + ' preview changed', 'Refresh Review before continuing.');
const populated = append(section, 'div', {
id: 'memory-review-' + config.key + '-preview-populated',
class: 'worker-heartbeats-content',
hidden: '',
});
const evidence = detailTable(populated, config.title + ' preview', ['Action', 'Records', 'Transition', 'Boundary'], { id: 'memory-review-' + config.key + '-preview-evidence' });
const controls = append(populated, 'div', { class: 'view-toolbar activity-panel-toolbar' });
const confirmButton = append(controls, 'button', {
id: 'memory-review-' + config.key + '-confirmation-button',
class: 'button button-primary',
type: 'button',
disabled: '',
}, 'Confirm ' + config.noun);
const confirming = state(section, 'memory-review-' + config.key + '-confirmation-confirming', 'worker-heartbeats-loading', 'status', 'Confirming ' + config.noun, config.confirmingDescription);
const succeeded = state(section, 'memory-review-' + config.key + '-confirmation-succeeded', 'worker-heartbeats-content', 'status', config.title + ' confirmed', config.successDescription);
const resultEvidence = detailTable(succeeded, config.title + ' result', ['Outcome', 'Records', 'Evidence', 'Boundary'], { id: 'memory-review-' + config.key + '-confirmation-evidence' });
const resultMalformed = state(section, 'memory-review-' + config.key + '-confirmation-malformed', 'error-band', 'alert', config.title + ' result malformed', 'Refresh Review before retrying.');
const resultUnavailable = state(section, 'memory-review-' + config.key + '-confirmation-unavailable', 'error-band', 'alert', config.title + ' unavailable', 'Refresh Review and request a fresh preview.');
const resultNotFound = state(section, 'memory-review-' + config.key + '-confirmation-not-found', 'empty-band', 'status', config.title + ' preview not found', 'Request a fresh preview before confirming.');
const conflict = state(section, 'memory-review-' + config.key + '-confirmation-conflict', 'error-band', 'alert', config.title + ' changed', 'Refresh Review before retrying.');
return {
button,
confirmButton,
evidence,
resultEvidence,
previewStates: [unrequested, loading, malformed, unavailable, notFound, stale, populated],
confirmationStates: [confirming, succeeded, resultMalformed, resultUnavailable, resultNotFound, conflict],
succeeded,
};
}

function appendRows(table, rows) {
const row = append(table, 'tr');
for (const [label, values] of rows) {
const value = append(row, 'td', { 'data-label': label });
for (const [className, text] of values) append(value, 'span', { class: className }, text);
}
}

function renderPreview(evidence, config, preview) {
const records = config.key === 'rollback'
? preview.affectedRecords.roles[0].count + ' restored'
: preview.affectedRecords.count + ' unchanged';
const consequence = config.key === 'rollback'
? preview.expected.retrievalConsequences.join(', ')
: preview.expected.unavailableEffects.join(', ');
const boundary = config.key === 'rollback'
? preview.confirmation.boundary : preview.rollback.boundary;
evidence.replaceChildren();
appendRows(evidence, [
['Action', [['worker-heartbeat-primary', config.title], ['worker-heartbeat-secondary', preview.proposalKind + ' - ' + preview.proposedEffect]]],
['Records', [['worker-heartbeat-primary', records], ['worker-heartbeat-secondary', consequence]]],
['Transition', [['worker-heartbeat-primary', preview.current.lifecycleState + ' -> ' + preview.expected.lifecycleState], ['worker-heartbeat-secondary', 'Revision ' + preview.expected.revisionNumber]]],
['Boundary', [['worker-heartbeat-primary', boundary], ['worker-heartbeat-secondary', preview.expected.durableEffects.join(', ')]]],
]);
}

function renderResult(table, config, result) {
const records = config.key === 'rollback'
? result.affectedRecords.count + ' restored - ' + result.retrievalConsequences.join(', ')
: 'No memory record mutation';
table.replaceChildren();
appendRows(table, [
['Outcome', [['worker-heartbeat-primary', config.title + ' revision ' + result.current.revisionNumber], ['worker-heartbeat-secondary', result.outcome]]],
['Records', [['worker-heartbeat-primary', records], ['worker-heartbeat-secondary', result.proposalRef]]],
['Evidence', [['worker-heartbeat-primary', 'Revision ' + result.evidence.revisionRef], ['worker-heartbeat-secondary', 'Audit ' + result.evidence.auditRef]]],
['Boundary', [['worker-heartbeat-primary', result.rollback.boundary], ['worker-heartbeat-secondary', 'Terminal transition']]],
]);
}

export function createMemoryMaintenanceTransitionWorkflow(config, options) {
const {
parent,
setHidden,
request,
showSessionExpired,
announce,
getCurrent,
authorityMatches,
onStateChange,
onBeforePreview,
onSuccess,
} = options;
const surface = createSurface(parent, config);
let previewSequence = 0;
let confirmationSequence = 0;
let expiryTimer = null;
let authority = null;
let previewState = 'unrequested';
let confirmationInFlight = false;

function hide(elements) {
for (const element of elements) setHidden(element, true);
}

function update(competingBusy = false) {
const detail = getCurrent()?.detail;
surface.button.disabled = competingBusy || confirmationInFlight
|| previewState === 'loading' || detail?.lifecycleState !== config.currentState;
surface.confirmButton.disabled = competingBusy || confirmationInFlight
|| authority === null || authority.expiresAt <= Date.now();
}

function showPreview(next) {
hide(surface.previewStates);
const index = ['unrequested', 'loading', 'malformed', 'unavailable', 'not-found', 'stale', 'populated'].indexOf(next);
if (index >= 0) setHidden(surface.previewStates[index], false);
previewState = next;
update();
onStateChange();
return next;
}

function showConfirmation(next) {
hide(surface.confirmationStates);
const index = ['confirming', 'succeeded', 'malformed', 'unavailable', 'not-found', 'conflict'].indexOf(next);
if (index >= 0) setHidden(surface.confirmationStates[index], false);
update();
onStateChange();
return next;
}

function clear(preserveResult = false) {
previewSequence += 1;
confirmationSequence += 1;
if (expiryTimer !== null) window.clearTimeout(expiryTimer);
expiryTimer = null;
authority = null;
confirmationInFlight = false;
surface.evidence.replaceChildren();
hide(surface.previewStates);
previewState = 'unrequested';
if (!preserveResult) {
surface.resultEvidence.replaceChildren();
hide(surface.confirmationStates);
}
update();
onStateChange();
}

function scheduleExpiry(expiresAt, sequence) {
const expire = () => {
if (sequence !== previewSequence) return;
const delay = expiresAt - Date.now();
if (delay > 0) {
expiryTimer = window.setTimeout(expire, Math.min(delay, 2_147_483_647));
return;
}
expiryTimer = null;
authority = null;
surface.evidence.replaceChildren();
showPreview('stale');
hide(surface.confirmationStates);
announce(config.title + ' preview expired.');
};
expire();
}

async function preview() {
const current = getCurrent();
if (surface.button.disabled || !current?.selected || !current.detail) return;
onBeforePreview();
const { selected, detail } = current;
if (expiryTimer !== null) window.clearTimeout(expiryTimer);
expiryTimer = null;
const sequence = ++previewSequence;
authority = null;
surface.resultEvidence.replaceChildren();
hide(surface.confirmationStates);
surface.evidence.replaceChildren();
showPreview('loading');
const response = await request(selected.handle, selected.scopeHandle, { action: config.requestAction });
if (sequence !== previewSequence) return;
if (!authorityMatches(selected) || getCurrent()?.detail !== detail) {
showPreview('stale');
announce(config.title + ' preview changed.');
return;
}
if (response.status === 401) {
showSessionExpired();
return;
}
if (response.status !== 201) {
const next = response.status === 404 ? 'not-found'
: response.status === 409 ? 'stale' : 'unavailable';
showPreview(next);
announce(config.title + (next === 'not-found' ? ' preview not found.'
: next === 'stale' ? ' preview changed.' : ' preview unavailable.'));
return;
}
const rendered = config.normalizePreview(response.body, selected, detail, Date.now());
showPreview(rendered.state);
if (rendered.state !== 'populated') {
announce(config.title + (rendered.state === 'stale' ? ' preview changed.' : ' preview malformed.'));
return;
}
renderPreview(surface.evidence, config, rendered.preview);
authority = {
previewHandle: response.body.previewHandle,
expiresAt: rendered.preview.previewExpiresAt,
selected: { ...selected },
detail,
expected: {
proposalKind: rendered.preview.proposalKind,
proposalRef: rendered.preview.proposalRef,
proposedEffect: rendered.preview.proposedEffect,
affectedRecords: rendered.preview.affectedRecords,
expectedRevisionNumber: rendered.preview.expected.revisionNumber,
},
};
scheduleExpiry(rendered.preview.previewExpiresAt, sequence);
update();
onStateChange();
announce(config.title + ' preview updated.');
}

function authorityIsCurrent(value) {
const current = getCurrent();
return authorityMatches(value.selected)
&& current?.detail === value.detail
&& current.detail.lifecycleState === config.currentState
&& current.detail.currentRevisionNumber + 1 === value.expected.expectedRevisionNumber;
}

async function confirm() {
if (confirmationInFlight || authority === null) return;
const current = authority;
if (current.expiresAt <= Date.now() || !authorityIsCurrent(current)) {
clear();
showPreview('stale');
announce(config.title + ' preview changed.');
return;
}
const sequence = ++confirmationSequence;
if (expiryTimer !== null) window.clearTimeout(expiryTimer);
expiryTimer = null;
previewSequence += 1;
authority = null;
confirmationInFlight = true;
surface.evidence.replaceChildren();
hide(surface.previewStates);
surface.resultEvidence.replaceChildren();
showConfirmation('confirming');
const response = await request(current.selected.handle, current.selected.scopeHandle, {
confirm: true,
previewHandle: current.previewHandle,
action: config.requestAction,
}, true);
if (sequence !== confirmationSequence) return;
confirmationInFlight = false;
if (response.status === 401) {
showSessionExpired();
return;
}
if (response.status !== 200) {
const next = response.status === 404 ? 'not-found'
: response.status === 409 ? 'conflict' : 'unavailable';
showConfirmation(next);
announce(config.title + (next === 'not-found' ? ' preview not found.'
: next === 'conflict' ? ' changed.' : ' unavailable.'));
return;
}
const result = config.normalizeResult(response.body, current.expected);
if (!result) {
showConfirmation('malformed');
announce(config.title + ' result malformed.');
return;
}
renderResult(surface.resultEvidence, config, result);
showConfirmation('succeeded');
announce(config.title + ' confirmed.');
onSuccess();
}

surface.button.addEventListener('click', () => { void preview(); });
surface.confirmButton.addEventListener('click', () => { void confirm(); });
showPreview('unrequested');

return {
busy: () => previewState === 'loading' || confirmationInFlight,
clear,
resultVisible: () => !surface.succeeded.hidden,
showUnrequested: () => showPreview('unrequested'),
update,
};
}

export const MEMORY_ROLLBACK_WORKFLOW = {
key: 'rollback',
title: 'Rollback',
noun: 'rollback',
currentState: 'applied',
requestAction: 'rollback',
confirmingDescription: 'Restoring the applied maintenance candidates.',
successDescription: 'The maintenance application was rolled back.',
normalizePreview: normalizeRollbackPreview,
normalizeResult: normalizeRollbackResult,
};

export const MEMORY_EXPIRATION_WORKFLOW = {
key: 'expiration',
title: 'Expiration',
noun: 'expiration',
currentState: 'pending_review',
requestAction: 'expire',
confirmingDescription: 'Expiring the pending maintenance proposal.',
successDescription: 'The pending proposal expired without memory record mutation.',
normalizePreview: normalizeExpirationPreview,
normalizeResult: normalizeExpirationResult,
};
