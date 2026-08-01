import {
append,
detailTable,
renderMemoryApplicationPreview,
} from '/governance/memory-presentation.js';

const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_KEYS = [
'action',
'outcome',
'proposalKind',
'proposalRef',
'proposedEffect',
'affectedRecords',
'selection',
'current',
'retrievalConsequences',
'evidence',
'rollback',
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

function normalizeResult(value, expected) {
if (!exactObject(value, RESULT_KEYS)
|| !exactObject(value.affectedRecords, ['count', 'fingerprint', 'roles'])
|| !exactObject(value.selection, ['required'], ['retainedMemoryRef'])
|| !exactObject(value.current, ['lifecycleState', 'revisionNumber'])
|| !exactObject(value.evidence, ['transition', 'revisionRef', 'auditRef'])
|| !exactObject(value.rollback, ['supported', 'boundary'])
|| value.action !== 'memory.maintenance.apply'
|| value.outcome !== 'applied'
|| value.proposalKind !== expected.proposalKind
|| value.proposalRef !== expected.proposalRef
|| value.proposedEffect !== expected.proposedEffect
|| value.affectedRecords.count !== expected.affectedRecords.count
|| value.affectedRecords.fingerprint !== expected.affectedRecords.fingerprint
|| !REFERENCE_PATTERN.test(value.proposalRef)
|| !FINGERPRINT_PATTERN.test(value.affectedRecords.fingerprint)
|| !Array.isArray(value.affectedRecords.roles)
|| value.affectedRecords.roles.length !== expected.affectedRecords.roles.length
|| value.selection.required !== expected.selection.required
|| value.current.lifecycleState !== 'applied'
|| value.current.revisionNumber !== expected.expectedRevisionNumber
|| !exactList(value.retrievalConsequences, expected.retrievalConsequences)
|| value.evidence.transition !== 'apply'
|| !REFERENCE_PATTERN.test(value.evidence.revisionRef)
|| !REFERENCE_PATTERN.test(value.evidence.auditRef)
|| value.rollback.supported !== true
|| value.rollback.boundary !== 'separate_confirmation_required') return null;
for (let index = 0; index < value.affectedRecords.roles.length; index += 1) {
const role = value.affectedRecords.roles[index];
const wanted = expected.affectedRecords.roles[index];
if (!exactObject(role, ['role', 'count', 'fingerprint'])
|| role.role !== wanted.role
|| role.count !== wanted.count
|| role.fingerprint !== wanted.fingerprint
|| !FINGERPRINT_PATTERN.test(role.fingerprint)) return null;
}
if (expected.selection.required) {
if (value.selection.retainedMemoryRef !== expected.retainedMemoryRef
|| !REFERENCE_PATTERN.test(value.selection.retainedMemoryRef)) return null;
} else if (Object.hasOwn(value.selection, 'retainedMemoryRef')) return null;
return value;
}

function state(parent, id, className, role, title, description) {
const element = append(parent, 'section', { id, class: className, role, hidden: '' });
append(element, 'h2', {}, title);
append(element, 'p', {}, description);
return element;
}

export function createMemoryApplicationWorkflow(options) {
const {
button,
retainedSelect,
evidence,
previewStates,
parent,
setHidden,
request,
showSessionExpired,
announce,
getCurrent,
authorityMatches,
onStateChange,
onSuccess,
} = options;
const controls = append(previewStates[6], 'div', { class: 'view-toolbar activity-panel-toolbar' });
const confirmButton = append(controls, 'button', {
id: 'memory-review-application-confirmation-button',
class: 'button button-primary',
type: 'button',
disabled: '',
}, 'Confirm application');
const confirming = state(parent, 'memory-review-application-confirmation-confirming', 'worker-heartbeats-loading', 'status', 'Confirming application', 'Applying the approved maintenance proposal.');
const succeeded = state(parent, 'memory-review-application-confirmation-succeeded', 'worker-heartbeats-content', 'status', 'Application confirmed', 'The approved maintenance proposal was applied.');
const malformed = state(parent, 'memory-review-application-confirmation-malformed', 'error-band', 'alert', 'Application result unavailable', 'The confirmation result was malformed. Refresh Review before retrying.');
const unavailable = state(parent, 'memory-review-application-confirmation-unavailable', 'error-band', 'alert', 'Application unavailable', 'Refresh Review and request a fresh preview.');
const notFound = state(parent, 'memory-review-application-confirmation-not-found', 'empty-band', 'status', 'Application preview not found', 'Request a fresh preview before confirming.');
const conflict = state(parent, 'memory-review-application-confirmation-conflict', 'error-band', 'alert', 'Application changed', 'The review changed. Refresh Review before retrying.');
const resultEvidence = detailTable(succeeded, 'Memory maintenance application result', ['Outcome', 'Records', 'Evidence', 'Rollback'], { id: 'memory-review-application-confirmation-evidence' });
const confirmationStates = [confirming, succeeded, malformed, unavailable, notFound, conflict];
let previewSequence = 0;
let confirmationSequence = 0;
let expiryTimer = null;
let authority = null;
let previewState = 'unrequested';
let confirmationInFlight = false;

function hide(elements) {
for (const element of elements) setHidden(element, true);
}

function update(decisionInFlight = false) {
const current = getCurrent();
const detail = current?.detail;
const loading = previewState === 'loading';
const ready = detail?.lifecycleState === 'approved'
&& (detail.kind !== 'conflict' || retainedSelect.value !== '');
button.disabled = decisionInFlight || confirmationInFlight || loading || !ready;
retainedSelect.disabled = decisionInFlight || confirmationInFlight || loading
|| detail?.kind !== 'conflict';
confirmButton.disabled = decisionInFlight || confirmationInFlight || authority === null
|| authority.expiresAt <= Date.now();
}

function showPreview(next) {
hide(previewStates);
const index = ['unrequested', 'loading', 'malformed', 'unavailable', 'not-found', 'stale', 'populated'].indexOf(next);
if (index >= 0) setHidden(previewStates[index], false);
previewState = next;
update();
onStateChange();
return next;
}

function showConfirmation(next) {
hide(confirmationStates);
const index = ['confirming', 'succeeded', 'malformed', 'unavailable', 'not-found', 'conflict'].indexOf(next);
if (index >= 0) setHidden(confirmationStates[index], false);
update();
onStateChange();
return next;
}

function clearAuthority() {
confirmationSequence += 1;
authority = null;
confirmationInFlight = false;
update();
onStateChange();
}

function clear(preserveResult = false) {
previewSequence += 1;
if (expiryTimer !== null) window.clearTimeout(expiryTimer);
expiryTimer = null;
clearAuthority();
evidence.replaceChildren();
hide(previewStates);
previewState = 'unrequested';
if (!preserveResult) {
resultEvidence.replaceChildren();
hide(confirmationStates);
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
evidence.replaceChildren();
showPreview('stale');
hide(confirmationStates);
announce('Application preview expired.');
};
expire();
}

async function preview() {
const current = getCurrent();
if (button.disabled || !current?.selected || !current.detail) return;
const { selected, detail } = current;
const retainedMemoryRef = detail.kind === 'conflict' ? retainedSelect.value : undefined;
const sequence = ++previewSequence;
authority = null;
resultEvidence.replaceChildren();
hide(confirmationStates);
evidence.replaceChildren();
showPreview('loading');
const response = await request(selected.handle, selected.scopeHandle, {
action: 'apply',
...(retainedMemoryRef ? { retainedMemoryRef } : {}),
});
if (sequence !== previewSequence) return;
const latest = getCurrent();
if (!authorityMatches(selected) || latest?.detail !== detail
|| (detail.kind === 'conflict' && retainedSelect.value !== retainedMemoryRef)) {
showPreview('stale');
announce('Application preview changed.');
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
announce(next === 'not-found' ? 'Application preview not found.'
: next === 'stale' ? 'Application preview changed.' : 'Application preview unavailable.');
return;
}
const rendered = renderMemoryApplicationPreview(
response.body,
selected,
detail,
retainedMemoryRef,
{ evidence },
Date.now(),
);
showPreview(rendered.state);
if (rendered.state !== 'populated') {
announce(rendered.state === 'stale' ? 'Application preview changed.' : 'Application preview malformed.');
return;
}
const previewValue = rendered.preview;
authority = {
previewHandle: response.body.previewHandle,
expiresAt: previewValue.previewExpiresAt,
selected: { ...selected },
detail,
retainedMemoryRef,
expected: {
proposalKind: previewValue.proposalKind,
proposalRef: previewValue.proposalRef,
proposedEffect: previewValue.proposedEffect,
affectedRecords: previewValue.affectedRecords,
selection: previewValue.selection,
expectedRevisionNumber: previewValue.expected.revisionNumber,
retrievalConsequences: previewValue.expected.retrievalConsequences,
retainedMemoryRef,
},
};
scheduleExpiry(previewValue.previewExpiresAt, sequence);
update();
onStateChange();
announce('Application preview updated.');
}

function authorityIsCurrent(value) {
const current = getCurrent();
return authorityMatches(value.selected)
&& current?.detail === value.detail
&& current.detail.lifecycleState === 'approved'
&& current.detail.currentRevisionNumber + 1 === value.expected.expectedRevisionNumber
&& (current.detail.kind !== 'conflict' || retainedSelect.value === value.retainedMemoryRef);
}

async function confirm() {
if (confirmationInFlight || authority === null) return;
const current = authority;
if (current.expiresAt <= Date.now() || !authorityIsCurrent(current)) {
clear();
showPreview('stale');
announce('Application preview changed.');
return;
}
const sequence = ++confirmationSequence;
if (expiryTimer !== null) window.clearTimeout(expiryTimer);
expiryTimer = null;
previewSequence += 1;
authority = null;
confirmationInFlight = true;
evidence.replaceChildren();
hide(previewStates);
resultEvidence.replaceChildren();
showConfirmation('confirming');
const response = await request(current.selected.handle, current.selected.scopeHandle, {
confirm: true,
previewHandle: current.previewHandle,
action: 'apply',
...(current.retainedMemoryRef ? { retainedMemoryRef: current.retainedMemoryRef } : {}),
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
announce(next === 'not-found' ? 'Application preview not found.'
: next === 'conflict' ? 'Application changed.' : 'Application unavailable.');
return;
}
const result = normalizeResult(response.body, current.expected);
if (!result) {
showConfirmation('malformed');
announce('Application result malformed.');
return;
}
resultEvidence.replaceChildren();
const roles = result.affectedRecords.roles.map((role) => role.role + ': ' + role.count).join(', ');
const selection = result.selection.required ? ' - retained ' + result.selection.retainedMemoryRef : '';
const consequences = result.retrievalConsequences.join(', ');
const rows = [
['Outcome', [['worker-heartbeat-primary', 'Applied revision ' + result.current.revisionNumber], ['worker-heartbeat-secondary', result.proposalKind + selection]]],
['Records', [['worker-heartbeat-primary', result.affectedRecords.count + ' affected'], ['worker-heartbeat-secondary', roles + ' - ' + consequences]]],
['Evidence', [['worker-heartbeat-primary', 'Revision ' + result.evidence.revisionRef], ['worker-heartbeat-secondary', 'Audit ' + result.evidence.auditRef]]],
['Rollback', [['worker-heartbeat-primary', 'Supported'], ['worker-heartbeat-secondary', result.rollback.boundary]]],
];
const row = append(resultEvidence, 'tr');
for (const [label, values] of rows) {
const value = append(row, 'td', { 'data-label': label });
for (const [className, text] of values) append(value, 'span', { class: className }, text);
}
showConfirmation('succeeded');
announce('Application confirmed.');
onSuccess();
}

button.addEventListener('click', () => { void preview(); });
retainedSelect.addEventListener('change', () => { clear(); showPreview('unrequested'); });
confirmButton.addEventListener('click', () => { void confirm(); });

return {
busy: () => previewState === 'loading' || confirmationInFlight,
clear,
resultVisible: () => !succeeded.hidden,
showUnrequested: () => showPreview('unrequested'),
update,
};
}
