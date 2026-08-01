import { append, detailTable } from '/governance/memory-presentation.js';

const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_KINDS = ['global', 'user', 'group', 'conversation', 'system'];
const DURABLE_EFFECTS = [
'memory_record_state_transition',
'memory_revision_append',
'audit_event_append',
];

function exactObject(value, required) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
const keys = Object.keys(value);
return keys.length === required.length
&& required.every((key) => Object.hasOwn(value, key));
}

function exactList(value, expected) {
return Array.isArray(value)
&& value.length === expected.length
&& value.every((entry, index) => entry === expected[index]);
}

function validRevision(value) {
return Number.isSafeInteger(value) && value > 0;
}

function normalizePreview(value, config, selected, detail, now) {
if (!exactObject(value, [
'action', 'recordRef', 'scopeKind', 'current', 'expected', 'rollback',
'previewDigest', 'previewHandle', 'previewExpiresAt',
])
|| !exactObject(value.current, ['lifecycleState', 'revisionNumber'])
|| !exactObject(value.expected, [
'lifecycleState', 'revisionNumber', 'durableEffects', 'retrievalConsequences',
])
|| !exactObject(value.rollback, ['supported', 'boundary'])
|| value.action !== config.action
|| !REFERENCE_PATTERN.test(value.recordRef)
|| !SCOPE_KINDS.includes(value.scopeKind)
|| !config.currentStates.includes(value.current.lifecycleState)
|| !validRevision(value.current.revisionNumber)
|| value.expected.lifecycleState !== config.expectedState
|| value.expected.revisionNumber !== value.current.revisionNumber + 1
|| !exactList(value.expected.durableEffects, DURABLE_EFFECTS)
|| !exactList(value.expected.retrievalConsequences, [config.consequence])
|| value.rollback.supported !== true
|| value.rollback.boundary !== config.previewBoundary
|| !DIGEST_PATTERN.test(value.previewDigest)
|| !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt)
|| value.previewExpiresAt <= now
|| !selected || !detail
|| selected.recordRef !== detail.record.recordRef
|| selected.state !== detail.record.state
|| selected.revisionCount !== detail.record.revisionCount
|| selected.scopeKind !== detail.record.scopeKind
|| value.scopeKind !== detail.record.scopeKind
|| value.current.lifecycleState !== detail.record.state
|| value.current.revisionNumber !== detail.record.revisionCount
|| value.previewExpiresAt > selected.handleExpiresAt
|| value.previewExpiresAt > selected.scopeExpiresAt) return null;
return {
recordRef: value.recordRef,
scopeKind: value.scopeKind,
current: { ...value.current },
expected: {
lifecycleState: value.expected.lifecycleState,
revisionNumber: value.expected.revisionNumber,
durableEffects: [...value.expected.durableEffects],
retrievalConsequences: [...value.expected.retrievalConsequences],
},
rollback: { ...value.rollback },
previewHandle: value.previewHandle,
previewExpiresAt: value.previewExpiresAt,
};
}

function normalizeResult(value, config, expected) {
if (!exactObject(value, [
'action', 'outcome', 'recordRef', 'scopeKind', 'current', 'durableEffects',
'retrievalConsequences', 'evidence', 'rollback',
])
|| !exactObject(value.current, ['lifecycleState', 'revisionNumber'])
|| !exactObject(value.evidence, ['changeType', 'revisionNumber', 'auditEvent'])
|| !exactObject(value.rollback, ['supported', 'boundary'])
|| value.action !== config.action
|| value.outcome !== config.outcome
|| value.recordRef !== expected.recordRef
|| value.scopeKind !== expected.scopeKind
|| value.current.lifecycleState !== config.expectedState
|| value.current.revisionNumber !== expected.expectedRevisionNumber
|| !exactList(value.durableEffects, DURABLE_EFFECTS)
|| !exactList(value.retrievalConsequences, [config.consequence])
|| value.evidence.changeType !== config.changeType
|| value.evidence.revisionNumber !== expected.expectedRevisionNumber
|| value.evidence.auditEvent !== config.auditEvent
|| value.rollback.supported !== true
|| value.rollback.boundary !== config.resultBoundary) return null;
return value;
}

function state(parent, id, className, role, title, description) {
const element = append(parent, 'section', { id, class: className, role, hidden: '' });
append(element, 'h3', {}, title);
append(element, 'p', {}, description);
return element;
}

function appendRows(table, rows) {
const row = append(table, 'tr');
for (const [label, primary, secondary] of rows) {
const value = append(row, 'td', { 'data-label': label });
append(value, 'span', { class: 'worker-heartbeat-primary' }, primary);
append(value, 'span', { class: 'worker-heartbeat-secondary' }, secondary);
}
}

function createSurface(parent, config) {
const section = append(parent, 'section', {
id: 'memory-record-' + config.key + '-workflow',
'aria-labelledby': 'memory-record-' + config.key + '-title',
});
const header = append(section, 'header', { class: 'view-toolbar activity-panel-toolbar' });
const title = append(header, 'div');
append(title, 'p', { class: 'eyebrow' }, 'Explicit confirmation required');
append(title, 'h3', { id: 'memory-record-' + config.key + '-title' }, config.title);
const previewButton = append(header, 'button', {
id: 'memory-record-' + config.key + '-preview-button',
class: 'button button-primary',
type: 'button',
'aria-controls': 'memory-record-' + config.key + '-populated',
disabled: '',
}, 'Preview ' + config.noun);
const unrequested = state(section, 'memory-record-' + config.key + '-unrequested', 'empty-band', 'status', config.title + ' not requested', 'No current preview is loaded.');
const loading = state(section, 'memory-record-' + config.key + '-loading', 'empty-band', 'status', 'Loading ' + config.noun + ' preview', 'Current effects are being prepared.');
const malformed = state(section, 'memory-record-' + config.key + '-malformed', 'error-band', 'alert', config.title + ' malformed', 'Refresh Records before retrying.');
const unavailable = state(section, 'memory-record-' + config.key + '-unavailable', 'error-band', 'alert', config.title + ' unavailable', 'Request a fresh preview.');
const notFound = state(section, 'memory-record-' + config.key + '-not-found', 'empty-band', 'status', config.title + ' not found', 'Refresh Records before continuing.');
const stale = state(section, 'memory-record-' + config.key + '-stale', 'error-band', 'alert', config.title + ' changed', 'Refresh Records before continuing.');
const populated = append(section, 'div', { id: 'memory-record-' + config.key + '-populated', class: 'worker-heartbeats-content', hidden: '' });
const evidence = detailTable(populated, config.title + ' preview', ['Action', 'Transition', 'Effects', 'Boundary']);
const controls = append(populated, 'div', { class: 'view-toolbar activity-panel-toolbar' });
const confirmButton = append(controls, 'button', {
id: 'memory-record-' + config.key + '-confirmation-button',
class: 'button button-primary',
type: 'button',
disabled: '',
}, 'Confirm ' + config.noun);
const confirming = state(section, 'memory-record-' + config.key + '-confirming', 'worker-heartbeats-loading', 'status', 'Confirming ' + config.noun, 'Applying the governed record transition.');
const succeeded = state(section, 'memory-record-' + config.key + '-succeeded', 'worker-heartbeats-content', 'status', config.title + ' confirmed', config.successDescription);
const resultEvidence = detailTable(succeeded, config.title + ' result', ['Outcome', 'Transition', 'Evidence', 'Boundary']);
const resultMalformed = state(section, 'memory-record-' + config.key + '-result-malformed', 'error-band', 'alert', config.title + ' result malformed', 'Refresh Records before retrying.');
const resultUnavailable = state(section, 'memory-record-' + config.key + '-result-unavailable', 'error-band', 'alert', config.title + ' confirmation unavailable', 'Refresh Records and request a fresh preview.');
const resultNotFound = state(section, 'memory-record-' + config.key + '-result-not-found', 'empty-band', 'status', config.title + ' preview not found', 'Request a fresh preview before confirming.');
const conflict = state(section, 'memory-record-' + config.key + '-conflict', 'error-band', 'alert', config.title + ' changed', 'Refresh Records before retrying.');
return {
previewButton,
confirmButton,
evidence,
resultEvidence,
previewStates: [unrequested, loading, malformed, unavailable, notFound, stale, populated],
confirmationStates: [confirming, succeeded, resultMalformed, resultUnavailable, resultNotFound, conflict],
succeeded,
};
}

export function createMemoryRecordMutationWorkflow(config, options) {
const {
parent, setHidden, request, showSessionExpired, announce, getCurrent,
onStateChange, onBeforePreview, onSuccess,
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

function selectionMatches(left, right) {
return Boolean(left && right
&& left.recordRef === right.recordRef
&& left.handle === right.handle
&& left.handleExpiresAt === right.handleExpiresAt
&& left.scopeHandle === right.scopeHandle
&& left.scopeFingerprint === right.scopeFingerprint
&& left.scopeExpiresAt === right.scopeExpiresAt);
}

function update(competingBusy = false) {
const detail = getCurrent()?.detail;
const ready = detail && config.currentStates.includes(detail.record.state)
&& detail.record.scopeKind !== 'tool';
surface.previewButton.disabled = competingBusy || confirmationInFlight
|| previewState === 'loading' || !ready;
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

function renderPreview(preview) {
surface.evidence.replaceChildren();
appendRows(surface.evidence, [
['Action', config.title, preview.recordRef],
['Transition', preview.current.lifecycleState + ' -> ' + preview.expected.lifecycleState, 'Revision ' + preview.expected.revisionNumber],
['Effects', preview.expected.retrievalConsequences.join(', '), preview.expected.durableEffects.join(', ')],
['Boundary', preview.rollback.boundary, 'Separate confirmation required'],
]);
}

function renderResult(result) {
surface.resultEvidence.replaceChildren();
appendRows(surface.resultEvidence, [
['Outcome', result.outcome, result.recordRef],
['Transition', result.current.lifecycleState, 'Revision ' + result.current.revisionNumber],
['Evidence', result.evidence.auditEvent, result.evidence.changeType],
['Boundary', result.rollback.boundary, result.retrievalConsequences.join(', ')],
]);
}

async function preview() {
const current = getCurrent();
if (surface.previewButton.disabled || !current?.selected || !current.detail) return;
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
if (!selectionMatches(getCurrent()?.selected, selected) || getCurrent()?.detail !== detail) {
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
const normalized = normalizePreview(response.body, config, selected, detail, Date.now());
if (!normalized) {
showPreview('malformed');
announce(config.title + ' preview malformed.');
return;
}
renderPreview(normalized);
authority = {
previewHandle: normalized.previewHandle,
expiresAt: normalized.previewExpiresAt,
selected: { ...selected },
detail,
expected: {
recordRef: normalized.recordRef,
scopeKind: normalized.scopeKind,
expectedRevisionNumber: normalized.expected.revisionNumber,
},
};
showPreview('populated');
scheduleExpiry(normalized.previewExpiresAt, sequence);
announce(config.title + ' preview ready.');
}

async function confirm() {
if (surface.confirmButton.disabled || confirmationInFlight || !authority) return;
const current = getCurrent();
const retained = authority;
if (!current?.selected || current.detail !== retained.detail
|| !selectionMatches(current.selected, retained.selected)
|| retained.expiresAt <= Date.now()) {
clear();
showPreview('stale');
announce(config.title + ' preview changed.');
return;
}
const sequence = ++confirmationSequence;
confirmationInFlight = true;
authority = null;
if (expiryTimer !== null) window.clearTimeout(expiryTimer);
expiryTimer = null;
hide(surface.previewStates);
showConfirmation('confirming');
const body = config.confirmBody(retained.previewHandle);
const response = await request(current.selected.handle, current.selected.scopeHandle, body, true);
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
const result = normalizeResult(response.body, config, retained.expected);
if (!result) {
showConfirmation('malformed');
announce(config.title + ' result malformed.');
return;
}
renderResult(result);
showConfirmation('succeeded');
onSuccess();
announce(config.title + ' confirmed.');
}

surface.previewButton.addEventListener('click', () => void preview());
surface.confirmButton.addEventListener('click', () => void confirm());
showPreview('unrequested');
return {
clear,
update,
busy: () => previewState === 'loading' || confirmationInFlight,
resultVisible: () => !surface.succeeded.hidden,
showUnrequested: () => showPreview('unrequested'),
};
}

export const MEMORY_RECORD_FORGET_WORKFLOW = {
key: 'forget',
title: 'Forget record',
noun: 'forget',
action: 'memory.record.forget',
requestAction: 'forget',
currentStates: ['proposed', 'active', 'rejected', 'superseded', 'disabled'],
expectedState: 'deleted',
outcome: 'forgotten',
consequence: 'deleted_record_excluded',
previewBoundary: 'separate_restore_confirmation_required',
resultBoundary: 'separate_restore_confirmation_required',
changeType: 'delete',
auditEvent: 'memory.delete',
confirmBody: (previewHandle) => ({ confirm: true, previewHandle }),
successDescription: 'The record was deleted and excluded from retrieval.',
};

export const MEMORY_RECORD_RESTORE_WORKFLOW = {
key: 'restore',
title: 'Restore record',
noun: 'restore',
action: 'memory.record.restore',
requestAction: 'restore',
currentStates: ['disabled', 'rejected', 'deleted'],
expectedState: 'active',
outcome: 'restored',
consequence: 'restored_records_included',
previewBoundary: 'separate_forget_confirmation_required',
resultBoundary: 'separate_forget_confirmation_required',
changeType: 'restore',
auditEvent: 'memory.restore',
confirmBody: (previewHandle) => ({ confirm: true, previewHandle, action: 'restore' }),
successDescription: 'The record was restored and included in retrieval.',
};
