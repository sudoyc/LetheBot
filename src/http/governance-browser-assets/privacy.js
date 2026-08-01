import { append, createElement, detailTable } from '/governance/memory-presentation.js';

const SCOPES_ENDPOINT = '/governance/api/v1/privacy/scopes';
const PREFERENCES_ENDPOINT = '/governance/api/v1/privacy/preferences';
const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TYPES = ['proactive_dm', 'memory_association'];
const STATES = ['opted_in', 'opted_out'];
const EFFECTS = ['privacy_preference_upsert', 'audit_event_append'];
const TYPE_LABELS = { proactive_dm: 'Proactive direct messages', memory_association: 'Memory association' };
const STATE_LABELS = { opted_in: 'Opted in', opted_out: 'Opted out' };

function exact(value, required, optional = []) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
const keys = Object.keys(value);
return required.every((key) => Object.hasOwn(value, key))
&& keys.every((key) => required.includes(key) || optional.includes(key));
}
function date(value) {
if (typeof value !== 'string') return false;
const time = Date.parse(value);
return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function text(value, maximum) {
return typeof value === 'string' && Array.from(value).length <= maximum;
}
function list(value, expected) {
return Array.isArray(value) && value.length === expected.length
&& value.every((entry, index) => entry === expected[index]);
}
function state(parent, id, className, role, title, description) {
const element = append(parent, 'section', { id, class: className, role, hidden: '' });
append(element, 'h2', {}, title);append(element, 'p', {}, description);return element;
}
function catalog(value, now) {
if (!exact(value, ['entries', 'truncated']) || !Array.isArray(value.entries)
|| value.entries.length > 100 || typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => exact(entry, [
'fingerprint', 'scopeKind', 'label', 'handle', 'expiresAt',
]) && REFERENCE_PATTERN.test(entry.fingerprint) && entry.scopeKind === 'user'
&& text(entry.label, 96) && OPAQUE_PATTERN.test(entry.handle)
&& Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now ? { ...entry } : null);
return entries.some((entry) => entry === null)
|| new Set(entries.map((entry) => entry.handle)).size !== entries.length
? null : { entries, truncated: value.truncated };
}
function preferences(value) {
if (!exact(value, ['entries', 'truncated']) || !Array.isArray(value.entries)
|| value.entries.length > 32 || typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => exact(entry, [
'preferenceType', 'state', 'createdAt', 'updatedAt',
], ['reason', 'updatedBy']) && TYPES.includes(entry.preferenceType)
&& STATES.includes(entry.state) && date(entry.createdAt) && date(entry.updatedAt)
&& (!Object.hasOwn(entry, 'reason') || text(entry.reason, 160))
&& (!Object.hasOwn(entry, 'updatedBy') || (exact(entry.updatedBy, ['actorClass', 'context'])
&& text(entry.updatedBy.actorClass, 32) && text(entry.updatedBy.context, 64)))
? { ...entry } : null);
return entries.some((entry) => entry === null) ? null : { entries, truncated: value.truncated };
}
function version(value) {
return exact(value, ['source', 'updatedAt'])
&& ((value.source === 'implicit_default' && value.updatedAt === null)
|| (value.source === 'stored_preference' && Number.isSafeInteger(value.updatedAt)
&& value.updatedAt >= 0));
}
function preview(value, selected, type, target, now) {
if (!exact(value, [
'action', 'preferenceType', 'current', 'expected', 'rollback', 'previewDigest',
'previewHandle', 'previewExpiresAt',
]) || value.action !== 'privacy.preference.change'
|| value.preferenceType !== type || !exact(value.current, ['state', 'version'])
|| !STATES.includes(value.current.state) || !version(value.current.version)
|| !exact(value.expected, ['state', 'durableEffects', 'enforcementConsequences'])
|| value.expected.state !== target || !list(value.expected.durableEffects, EFFECTS)
|| !list(value.expected.enforcementConsequences, ['preference_enforced_immediately'])
|| !exact(value.rollback, ['supported', 'targetState', 'boundary'])
|| value.rollback.supported !== true || value.rollback.targetState !== value.current.state
|| value.rollback.boundary !== 'separate_preference_change_confirmation_required'
|| !DIGEST_PATTERN.test(value.previewDigest) || !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt) || value.previewExpiresAt <= now
|| value.previewExpiresAt > selected.expiresAt) return null;
return {
preferenceType: value.preferenceType,current: { ...value.current },expected: { ...value.expected },
rollback: { ...value.rollback },previewHandle: value.previewHandle,
previewExpiresAt: value.previewExpiresAt,
};
}
function result(value, expected) {
return exact(value, [
'action', 'outcome', 'preferenceType', 'current', 'durableEffects',
'enforcementConsequences', 'evidence', 'rollback',
]) && value.action === 'privacy.preference.change' && value.outcome === 'updated'
&& value.preferenceType === expected.preferenceType
&& exact(value.current, ['state', 'version']) && value.current.state === expected.state
&& exact(value.current.version, ['source', 'updatedAt'])
&& value.current.version.source === 'stored_preference'
&& Number.isSafeInteger(value.current.version.updatedAt)
&& value.current.version.updatedAt >= 0 && list(value.durableEffects, EFFECTS)
&& list(value.enforcementConsequences, ['preference_enforced_immediately'])
&& exact(value.evidence, ['auditEvent', 'updatedAt'])
&& value.evidence.auditEvent === 'privacy.preference_set'
&& Number.isSafeInteger(value.evidence.updatedAt) && value.evidence.updatedAt >= 0
&& exact(value.rollback, ['supported', 'targetState', 'boundary'])
&& value.rollback.supported === true && STATES.includes(value.rollback.targetState)
&& value.rollback.targetState !== expected.state
&& value.rollback.boundary === 'separate_preference_change_confirmation_required'
? value : null;
}
function rows(table, values) {
table.replaceChildren();const row = append(table, 'tr');
for (const [label, primary, secondary] of values) {
const cell = append(row, 'td', { 'data-label': label });append(cell, 'span', { class: 'worker-heartbeat-primary' }, primary);
append(cell, 'span', { class: 'worker-heartbeat-secondary' }, secondary);
}
}
function preferenceRows(table, values) {
table.replaceChildren();const labels = ['Preference', 'State', 'Updated'];
for (const valuesForRow of values) { const row = append(table, 'tr');for (const [index, value] of valuesForRow.entries()) { const cell = append(row, 'td', { 'data-label': labels[index] });append(cell, 'span', { class: 'worker-heartbeat-primary' }, value); } }
}

export function createPrivacyFeature(elements, setHidden, requestJson, mutate, expired, announce) {
const nav = createElement('button', { id: 'privacy-nav', class: 'nav-item', type: 'button', 'aria-controls': 'privacy-view' }, 'Privacy');
elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', { id: 'privacy-view', class: 'memory-view', 'aria-labelledby': 'privacy-title', hidden: '' });
elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });const heading = append(toolbar, 'div');
append(heading, 'p', { class: 'eyebrow' }, 'Governed preferences');append(heading, 'h1', { id: 'privacy-title' }, 'Privacy');
const refresh = append(toolbar, 'button', { id: 'privacy-refresh-button', class: 'button button-secondary', type: 'button' }, 'Refresh');
const controls = append(view, 'section', { class: 'memory-scope-band governance-control-grid', 'aria-labelledby': 'privacy-controls-title' });
append(controls, 'h2', { id: 'privacy-controls-title' }, 'Preference scope');
const scopeControl = append(controls, 'div');append(scopeControl, 'label', { for: 'privacy-scope-select' }, 'User scope');
const scopeSelect = append(scopeControl, 'select', { id: 'privacy-scope-select', disabled: '' });
append(scopeSelect, 'option', { value: '' }, 'Select a user scope');
const typeControl = append(controls, 'div');append(typeControl, 'label', { for: 'privacy-type-select' }, 'Preference type');
const typeSelect = append(typeControl, 'select', { id: 'privacy-type-select' });
for (const type of TYPES) append(typeSelect, 'option', { value: type }, TYPE_LABELS[type]);
const targetControl = append(controls, 'div');append(targetControl, 'label', { for: 'privacy-target-select' }, 'Target state');
const targetSelect = append(targetControl, 'select', { id: 'privacy-target-select' });
for (const target of STATES) append(targetSelect, 'option', { value: target }, STATE_LABELS[target]);
const previewButton = append(controls, 'button', { id: 'privacy-preview-button', class: 'button button-primary', type: 'button', disabled: '', 'aria-controls': 'privacy-preview' }, 'Preview change');
const loading = state(view, 'privacy-loading', 'empty-band', 'status', 'Loading privacy preferences', 'Current preference evidence is being refreshed.');
const unavailable = state(view, 'privacy-unavailable', 'error-band', 'alert', 'Privacy preferences unavailable', 'Refresh before continuing.');
const empty = state(view, 'privacy-empty', 'empty-band', 'status', 'No governed user scopes', 'Refresh after a governed user scope becomes available.');
const current = append(view, 'div', { id: 'privacy-current', class: 'worker-heartbeats-content', hidden: '' });
const currentTable = detailTable(current, 'Current preferences', ['Preference', 'State', 'Updated']);
const previewSurface = append(view, 'div', { id: 'privacy-preview', class: 'worker-heartbeats-content', hidden: '' });
const previewTable = detailTable(previewSurface, 'Preference change preview', ['Preference', 'Transition', 'Effects', 'Boundary']);
const confirmButton = append(previewSurface, 'button', { id: 'privacy-confirm-button', class: 'button button-primary', type: 'button', disabled: '' }, 'Confirm preference change');
const success = state(view, 'privacy-success', 'worker-heartbeats-content', 'status', 'Privacy preference updated', 'The bounded preference change was confirmed.');
const resultTable = detailTable(success, 'Preference change result', ['Preference', 'State', 'Evidence', 'Boundary']);
let scopes = [];let authority = null;let catalogSequence = 0;let readSequence = 0;let previewSequence = 0;let confirmSequence = 0;let timer = null;
function scope() { const index = Number(scopeSelect.value) - 1;return scopes[index] || null; }
function clearAuthority() { previewSequence += 1;confirmSequence += 1;if (timer !== null) window.clearTimeout(timer);timer = null;authority = null;previewTable.replaceChildren();setHidden(previewSurface, true);confirmButton.disabled = true; }
function update() { previewButton.disabled = !scope() || authority !== null; }
function clearChoice() { clearAuthority();setHidden(success, true);setHidden(unavailable, true);update(); }
async function loadPreferences() {
const selected = scope();clearAuthority();setHidden(empty, true);setHidden(unavailable, true);setHidden(current, true);if (!selected) { update();return; }
const sequence = ++readSequence;setHidden(loading, false);
const response = await requestJson(PREFERENCES_ENDPOINT, { headers: { 'X-LetheBot-Scope': selected.handle } });
if (sequence !== readSequence) return;setHidden(loading, true);
if (response.status === 401) return expired();const page = response.status === 200 ? preferences(response.body) : null;
if (!page) { setHidden(unavailable, false);announce('Privacy preferences unavailable.');return; }
preferenceRows(currentTable, page.entries.map((entry) => [TYPE_LABELS[entry.preferenceType], STATE_LABELS[entry.state], entry.updatedAt]));
setHidden(unavailable, true);setHidden(current, false);update();announce('Privacy preferences updated.');
}
async function loadCatalog() {
const sequence = ++catalogSequence;readSequence += 1;clearAuthority();setHidden(success, true);setHidden(empty, true);setHidden(unavailable, true);setHidden(current, true);refresh.disabled = true;scopeSelect.disabled = true;setHidden(loading, false);
const response = await requestJson(SCOPES_ENDPOINT);if (sequence !== catalogSequence) return;refresh.disabled = false;setHidden(loading, true);
if (response.status === 401) return expired();const normalized = response.status === 200 ? catalog(response.body, Date.now()) : null;
if (!normalized) { setHidden(unavailable, false);announce('Privacy scopes unavailable.');return; }
scopes = normalized.entries;scopeSelect.replaceChildren(createElement('option', { value: '' }, 'Select a user scope'));
for (const [index, entry] of scopes.entries()) append(scopeSelect, 'option', { value: String(index + 1) }, entry.label + ' — scope ' + String(index + 1));
scopeSelect.disabled = scopes.length === 0;setHidden(empty, scopes.length !== 0);setHidden(unavailable, true);setHidden(current, true);update();announce(scopes.length ? 'Privacy scopes updated.' : 'No privacy scopes.');
}
async function loadPreview() {
const selected = scope();if (!selected || previewButton.disabled) return;clearAuthority();setHidden(success, true);setHidden(unavailable, true);const sequence = ++previewSequence;
const preferenceType = typeSelect.value;const targetState = targetSelect.value;previewButton.disabled = true;
const response = await mutate(PREFERENCES_ENDPOINT, selected.handle, { action: 'change', preferenceType, targetState });
if (sequence !== previewSequence) return;if (response.status === 401) return expired();
const normalized = response.status === 201 ? preview(response.body, selected, preferenceType, targetState, Date.now()) : null;
if (!normalized) { previewButton.disabled = false;setHidden(unavailable, false);announce('Privacy preview unavailable.');return; }
rows(previewTable, [[TYPE_LABELS[normalized.preferenceType], STATE_LABELS[normalized.expected.state], STATE_LABELS[normalized.current.state]], ['Transition', STATE_LABELS[normalized.current.state], STATE_LABELS[normalized.expected.state]], ['Effects', normalized.expected.enforcementConsequences.join(', '), normalized.expected.durableEffects.join(', ')], ['Boundary', 'A later preference change requires a new preview and confirmation', 'Confirm this change before preview expiry']]);
authority = { selected: { ...selected }, type: preferenceType, target: targetState, handle: normalized.previewHandle, expiresAt: normalized.previewExpiresAt };
setHidden(previewSurface, false);confirmButton.disabled = false;timer = window.setTimeout(() => { authority = null;confirmButton.disabled = true;setHidden(previewSurface, true);update();announce('Privacy preview expired. Request a fresh preview.'); }, Math.min(normalized.previewExpiresAt - Date.now(), 2_147_483_647));announce('Privacy preview ready. Confirmation is available until the preview expires.');
}
async function confirm() {
const retained = authority;const selected = scope();if (!retained || confirmButton.disabled || !selected || selected.handle !== retained.selected.handle || retained.expiresAt <= Date.now()) { clearAuthority();return; }
authority = null;confirmButton.disabled = true;if (timer !== null) window.clearTimeout(timer);timer = null;const sequence = ++confirmSequence;
const response = await mutate(PREFERENCES_ENDPOINT + '/confirm', selected.handle, { confirm: true, previewHandle: retained.handle, preferenceType: retained.type, targetState: retained.target });
if (sequence !== confirmSequence) return;if (response.status === 401) return expired();const normalized = response.status === 200 ? result(response.body, { preferenceType: retained.type, state: retained.target }) : null;
if (!normalized) { setHidden(previewSurface, true);setHidden(unavailable, false);update();announce('Privacy confirmation unavailable. Request a fresh preview.');return; }
rows(resultTable, [[TYPE_LABELS[normalized.preferenceType], STATE_LABELS[normalized.current.state], normalized.outcome], ['State', STATE_LABELS[normalized.current.state], String(normalized.current.version.updatedAt)], ['Evidence', normalized.evidence.auditEvent, String(normalized.evidence.updatedAt)], ['Boundary', 'A later preference change requires a new preview and confirmation', 'Rollback is a separate governed change']]);
setHidden(previewSurface, true);setHidden(success, false);announce('Privacy preference updated.');void loadPreferences();
}
scopeSelect.addEventListener('change', () => { clearChoice();void loadPreferences(); });refresh.addEventListener('click', () => void loadCatalog());typeSelect.addEventListener('change', clearChoice);targetSelect.addEventListener('change', clearChoice);previewButton.addEventListener('click', () => void loadPreview());confirmButton.addEventListener('click', () => void confirm());setHidden(loading, true);setHidden(unavailable, true);setHidden(empty, true);setHidden(success, true);update();
return { nav, view, load: loadCatalog, reset: () => { catalogSequence += 1;readSequence += 1;clearAuthority();scopes = [];scopeSelect.replaceChildren(createElement('option', { value: '' }, 'Select a user scope'));scopeSelect.disabled = true;currentTable.replaceChildren();resultTable.replaceChildren();setHidden(current, true);setHidden(empty, true);setHidden(success, true);setHidden(view, true); } };
}
