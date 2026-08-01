import { append, createElement, detailTable } from '/governance/memory-presentation.js';

const SCOPES_ENDPOINT = '/governance/api/v1/display-profile/scopes';
const TARGETS_ENDPOINT = '/governance/api/v1/display-profile/targets';
const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TARGET_KINDS = ['private_or_global', 'group'];
const TRUST = ['platform_provided', 'user_set', 'inferred'];
const LIFECYCLES = ['absent', 'open', 'closed', 'mixed'];
const TARGET_KIND_LABELS = { private_or_global: 'Private or global', group: 'Group' };

function exact(value, required, optional = []) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
const keys = Object.keys(value);return required.every((key) => Object.hasOwn(value, key))
&& keys.every((key) => required.includes(key) || optional.includes(key));
}
function dateOrNull(value) {
if (value === null) return true;return date(value);
}
function date(value) {
if (typeof value !== 'string') return false;
const time = Date.parse(value);return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function bounded(value, maximum) { return typeof value === 'string' && Array.from(value).length <= maximum; }
function list(value, expected) { return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]); }
function target(value, optional = []) {
return exact(value, ['fingerprint', 'targetKind', 'label', 'currentProfile', 'history'], optional)
&& REFERENCE_PATTERN.test(value.fingerprint) && TARGET_KINDS.includes(value.targetKind)
&& value.label === (value.targetKind === 'group' ? 'Group display data' : 'Private/global display data')
&& exact(value.currentProfile, ['present', 'trust', 'observedAt'])
&& typeof value.currentProfile.present === 'boolean'
&& (value.currentProfile.trust === null || TRUST.includes(value.currentProfile.trust))
&& dateOrNull(value.currentProfile.observedAt)
&& exact(value.history, ['count', 'truncated', 'lifecycle', 'latestObservedAt'])
&& Number.isSafeInteger(value.history.count) && value.history.count >= 0
&& typeof value.history.truncated === 'boolean' && LIFECYCLES.includes(value.history.lifecycle)
&& dateOrNull(value.history.latestObservedAt);
}
function catalog(value, now) {
if (!exact(value, ['entries', 'truncated']) || !Array.isArray(value.entries) || value.entries.length > 100 || typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => exact(entry, ['fingerprint', 'scopeKind', 'label', 'handle', 'expiresAt'])
&& REFERENCE_PATTERN.test(entry.fingerprint) && entry.scopeKind === 'user' && bounded(entry.label, 96)
&& OPAQUE_PATTERN.test(entry.handle) && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now ? { ...entry } : null);
return entries.some((entry) => entry === null) || new Set(entries.map((entry) => entry.handle)).size !== entries.length ? null : { entries, truncated: value.truncated };
}
function page(value, now) {
if (!exact(value, ['entries', 'truncated']) || !Array.isArray(value.entries) || value.entries.length > 100 || typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => target(entry, ['handle', 'handleExpiresAt'])
&& exact(entry, ['fingerprint', 'targetKind', 'label', 'currentProfile', 'history', 'handle', 'handleExpiresAt'])
&& OPAQUE_PATTERN.test(entry.handle) && Number.isSafeInteger(entry.handleExpiresAt) && entry.handleExpiresAt > now ? { ...entry } : null);
return entries.some((entry) => entry === null)
|| new Set(entries.map((entry) => entry.fingerprint)).size !== entries.length
|| new Set(entries.map((entry) => entry.handle)).size !== entries.length ? null : { entries, truncated: value.truncated };
}
function displayValue(value, optional = []) { return exact(value, ['value', 'redacted', 'truncated'], optional) && bounded(value.value, 160) && typeof value.redacted === 'boolean' && typeof value.truncated === 'boolean'; }
function detail(value, selected) {
if (!exact(value, ['target', 'currentDisplay', 'nicknameHistory', 'nicknameHistoryTruncated'])
|| !target(value.target) || value.target.fingerprint !== selected.fingerprint
|| (value.currentDisplay !== null && !displayValue(value.currentDisplay))
|| !Array.isArray(value.nicknameHistory) || value.nicknameHistory.length > 100
|| typeof value.nicknameHistoryTruncated !== 'boolean') return null;
for (const entry of value.nicknameHistory) if (!displayValue(entry, ['fingerprint', 'observedAt', 'observedUntil'])
|| !exact(entry, ['value', 'redacted', 'truncated', 'fingerprint', 'observedAt', 'observedUntil'])
|| !REFERENCE_PATTERN.test(entry.fingerprint) || !dateOrNull(entry.observedAt) || !dateOrNull(entry.observedUntil)) return null;
return value;
}
function effectLists(current) {
const effects = [];if (current.displayProfileRows > 0) effects.push('display_profile_rows_redacted');
if (current.nicknameHistoryRows > 0) effects.push('nickname_history_rows_redacted');
if (current.openNicknameHistoryRows > 0) effects.push('open_nickname_history_rows_closed');effects.push('audit_event_append');
const consequences = ['display_values_enforced_as_redacted'];if (current.openNicknameHistoryRows > 0) consequences.push('open_history_intervals_closed');return [effects, consequences];
}
function snapshot(value) { return exact(value, ['displayProfileRows', 'nicknameHistoryRows', 'openNicknameHistoryRows', 'snapshotFingerprint'])
&& [value.displayProfileRows, value.nicknameHistoryRows, value.openNicknameHistoryRows].every((count) => Number.isSafeInteger(count) && count >= 0)
&& value.openNicknameHistoryRows <= value.nicknameHistoryRows && DIGEST_PATTERN.test(value.snapshotFingerprint); }
function preview(value, selected, scope, now) {
if (!exact(value, ['action', 'target', 'current', 'expected', 'rollback', 'previewDigest', 'previewHandle', 'previewExpiresAt'])
|| value.action !== 'display_profile.redact' || !target(value.target) || value.target.fingerprint !== selected.fingerprint
|| !snapshot(value.current) || !exact(value.expected, ['affectedRows', 'durableEffects', 'privacyConsequences'])
|| !exact(value.expected.affectedRows, ['displayProfiles', 'nicknameHistory', 'total'])) return null;
const rows = value.expected.affectedRows;const [effects, consequences] = effectLists(value.current);
if (rows.displayProfiles !== value.current.displayProfileRows || rows.nicknameHistory !== value.current.nicknameHistoryRows
|| rows.total !== rows.displayProfiles + rows.nicknameHistory || !list(value.expected.durableEffects, effects)
|| !list(value.expected.privacyConsequences, consequences)
|| !exact(value.rollback, ['supported', 'boundary']) || value.rollback.supported !== false
|| value.rollback.boundary !== 'redacted_display_values_are_not_recoverable'
|| !DIGEST_PATTERN.test(value.previewDigest) || !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt) || value.previewExpiresAt <= now
|| value.previewExpiresAt > selected.handleExpiresAt || value.previewExpiresAt > scope.expiresAt) return null;
return { target: value.target, current: value.current, expected: value.expected, rollback: value.rollback, handle: value.previewHandle, expiresAt: value.previewExpiresAt };
}
function result(value, selected) {
if (!exact(value, ['action', 'outcome', 'target', 'affectedRows', 'openNicknameHistoryRowsClosed', 'redactedAt', 'durableEffects', 'privacyConsequences', 'evidence', 'rollback'])
|| value.action !== 'display_profile.redact' || value.outcome !== 'redacted'
|| !target(value.target) || value.target.fingerprint !== selected.fingerprint
|| !exact(value.affectedRows, ['displayProfiles', 'nicknameHistory', 'total'])
|| ![value.affectedRows.displayProfiles, value.affectedRows.nicknameHistory, value.affectedRows.total, value.openNicknameHistoryRowsClosed].every((count) => Number.isSafeInteger(count) && count >= 0)
|| value.affectedRows.total !== value.affectedRows.displayProfiles + value.affectedRows.nicknameHistory
|| value.openNicknameHistoryRowsClosed > value.affectedRows.nicknameHistory
|| !date(value.redactedAt)) return null;
const current = { displayProfileRows: value.affectedRows.displayProfiles, nicknameHistoryRows: value.affectedRows.nicknameHistory, openNicknameHistoryRows: value.openNicknameHistoryRowsClosed };
const [effects, consequences] = effectLists(current);
return list(value.durableEffects, effects) && list(value.privacyConsequences, consequences)
&& exact(value.evidence, ['auditEvent', 'reasonCode']) && value.evidence.auditEvent === 'display_profile.redact'
&& value.evidence.reasonCode === 'governance_http_display_profile_redaction_confirmed'
&& exact(value.rollback, ['supported', 'boundary']) && value.rollback.supported === false
&& value.rollback.boundary === 'redacted_display_values_are_not_recoverable' ? value : null;
}
function state(parent, id, className, role, title, description) { const element = append(parent, 'section', { id, class: className, role, hidden: '' });append(element, 'h2', {}, title);append(element, 'p', {}, description);return element; }
function rows(table, values) { table.replaceChildren();const row = append(table, 'tr');for (const [label, primary, secondary] of values) { const cell = append(row, 'td', { 'data-label': label });append(cell, 'span', { class: 'worker-heartbeat-primary' }, primary);append(cell, 'span', { class: 'worker-heartbeat-secondary' }, secondary); } }

export function createDisplayProfileFeature(elements, setHidden, requestJson, mutate, expired, announce) {
const nav = createElement('button', { id: 'display-profile-nav', class: 'nav-item', type: 'button', 'aria-controls': 'display-profile-view' }, 'Display data');elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', { id: 'display-profile-view', class: 'memory-view', 'aria-labelledby': 'display-profile-title', hidden: '' });elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });const heading = append(toolbar, 'div');append(heading, 'p', { class: 'eyebrow' }, 'Irrecoverable redaction');append(heading, 'h1', { id: 'display-profile-title' }, 'Display profile data');const refresh = append(toolbar, 'button', { class: 'button button-secondary', type: 'button' }, 'Refresh');
const controls = append(view, 'section', { class: 'memory-scope-band governance-control-grid', 'aria-labelledby': 'display-profile-scope-title' });append(controls, 'h2', { id: 'display-profile-scope-title' }, 'Exact user scope');const scopeControl = append(controls, 'div');append(scopeControl, 'label', { for: 'display-profile-scope-select' }, 'User scope');const select = append(scopeControl, 'select', { id: 'display-profile-scope-select', disabled: '' });append(select, 'option', { value: '' }, 'Select a user scope');
const loading = state(view, 'display-profile-loading', 'empty-band', 'status', 'Loading display data', 'Bounded display data is being refreshed.');const unavailable = state(view, 'display-profile-unavailable', 'error-band', 'alert', 'Display data unavailable', 'Refresh before continuing.');const empty = state(view, 'display-profile-empty', 'empty-band', 'status', 'No display targets', 'No governed display data exists in this scope.');
const unselected = state(view, 'display-profile-unselected', 'empty-band', 'status', 'Choose a governed user scope', 'Select one exact user scope when available; refresh if the scope catalog is empty.');
const content = append(view, 'section', { class: 'worker-heartbeats-content', hidden: '' });const targets = append(content, 'div', { id: 'display-profile-targets', class: 'memory-records-list' });
const detailSurface = append(view, 'section', { id: 'display-profile-detail', class: 'worker-heartbeats-content', hidden: '' });const displayDetailTable = detailTable(detailSurface, 'Display target', ['Target', 'Current display', 'History', 'Boundary']);const previewButton = append(detailSurface, 'button', { id: 'display-profile-preview-button', class: 'button button-primary', type: 'button', disabled: '', 'aria-controls': 'display-profile-preview' }, 'Preview redaction');
const previewSurface = append(view, 'section', { id: 'display-profile-preview', class: 'worker-heartbeats-content', hidden: '' });const previewTable = detailTable(previewSurface, 'Redaction preview', ['Target', 'Rows', 'Consequences', 'Boundary']);const confirmButton = append(previewSurface, 'button', { id: 'display-profile-confirm-button', class: 'button button-primary', type: 'button', disabled: '' }, 'Confirm irreversible redaction');
const success = state(view, 'display-profile-success', 'worker-heartbeats-content', 'status', 'Display data redacted', 'The confirmed display values cannot be recovered.');const resultTable = detailTable(success, 'Redaction result', ['Target', 'Rows', 'Evidence', 'Boundary']);
let scopes = [];let entries = [];let selectedTarget = null;let selectedDetail = null;let authority = null;let catalogSequence = 0;let listSequence = 0;let detailSequence = 0;let previewSequence = 0;let confirmSequence = 0;let timer = null;
function scope() { return scopes[Number(select.value) - 1] || null; }
function setTargetExpanded(button = null) { for (const control of targets.querySelectorAll('[data-display-index]')) control.setAttribute('aria-expanded', control === button ? 'true' : 'false'); }
function clearAuthority() { previewSequence += 1;confirmSequence += 1;if (timer !== null) window.clearTimeout(timer);timer = null;authority = null;confirmButton.disabled = true;previewTable.replaceChildren();setHidden(previewSurface, true);previewButton.disabled = !selectedDetail; }
function clearDetail() { detailSequence += 1;clearAuthority();setTargetExpanded();selectedTarget = null;selectedDetail = null;displayDetailTable.replaceChildren();setHidden(detailSurface, true); }
async function loadDetail(entry) { const selectedScope = scope();if (!selectedScope) return;clearDetail();selectedTarget = entry;const sequence = ++detailSequence;setHidden(unavailable, true);setHidden(loading, false);const response = await requestJson(TARGETS_ENDPOINT + '/' + entry.handle, { headers: { 'X-LetheBot-Scope': selectedScope.handle } });if (sequence !== detailSequence) return;setHidden(loading, true);if (response.status === 401) return expired();const normalized = response.status === 200 ? detail(response.body, entry) : null;if (!normalized) { setTargetExpanded(); setHidden(unavailable, false); announce('Display target unavailable.'); return; }selectedDetail = normalized;rows(displayDetailTable, [['Target', normalized.target.label, TARGET_KIND_LABELS[normalized.target.targetKind]], ['Current display', normalized.currentDisplay ? normalized.currentDisplay.value : 'No current display', normalized.currentDisplay?.redacted ? 'Redacted' : 'Bounded value'], ['History', String(normalized.nicknameHistory.length), normalized.nicknameHistoryTruncated ? 'First 100 only' : normalized.target.history.lifecycle], ['Boundary', 'Redaction is irreversible', 'Display values cannot be recovered']]);setHidden(unavailable, true);setHidden(detailSurface, false);previewButton.disabled = false;announce('Display target updated.'); }
async function loadTargets() { const selectedScope = scope();clearDetail();entries = [];targets.replaceChildren();setHidden(unavailable, true);setHidden(content, true);setHidden(empty, true);setHidden(unselected, true);if (!selectedScope) { setHidden(unselected, false);return; }const sequence = ++listSequence;setHidden(loading, false);const response = await requestJson(TARGETS_ENDPOINT, { headers: { 'X-LetheBot-Scope': selectedScope.handle } });if (sequence !== listSequence) return;setHidden(loading, true);if (response.status === 401) return expired();const normalized = response.status === 200 ? page(response.body, Date.now()) : null;if (!normalized) { setHidden(unavailable, false);announce('Display targets unavailable.');return; }entries = normalized.entries;for (const [index, entry] of entries.entries()) { const button = append(targets, 'button', { class: 'memory-record-row', type: 'button', 'data-display-index': String(index), 'aria-controls': 'display-profile-detail', 'aria-expanded': 'false' });append(button, 'span', { class: 'memory-record-primary' }, entry.label);append(button, 'span', { class: 'memory-record-secondary' }, entry.currentProfile.present ? 'Profile present' : 'History only'); }setHidden(unavailable, true);setHidden(empty, entries.length !== 0);setHidden(content, entries.length === 0);announce(entries.length ? 'Display targets updated.' : 'No display targets.'); }
async function loadCatalog() { const sequence = ++catalogSequence;listSequence += 1;clearDetail();setHidden(success, true);setHidden(unavailable, true);setHidden(content, true);setHidden(empty, true);setHidden(unselected, true);refresh.disabled = true;select.disabled = true;setHidden(loading, false);const response = await requestJson(SCOPES_ENDPOINT);if (sequence !== catalogSequence) return;refresh.disabled = false;setHidden(loading, true);if (response.status === 401) return expired();const normalized = response.status === 200 ? catalog(response.body, Date.now()) : null;if (!normalized) { setHidden(unavailable, false);announce('Display scopes unavailable.');return; }scopes = normalized.entries;select.replaceChildren(createElement('option', { value: '' }, 'Select a user scope'));for (const [index, entry] of scopes.entries()) append(select, 'option', { value: String(index + 1) }, entry.label + ' — scope ' + String(index + 1));select.disabled = scopes.length === 0;setHidden(unavailable, true);setHidden(empty, true);setHidden(unselected, false);announce(scopes.length ? 'Display scopes updated.' : 'No display scopes.'); }
async function loadPreview() { const selectedScope = scope();if (!selectedScope || !selectedTarget || !selectedDetail || previewButton.disabled) return;clearAuthority();setHidden(success, true);setHidden(unavailable, true);const sequence = ++previewSequence;previewButton.disabled = true;const response = await mutate(TARGETS_ENDPOINT + '/' + selectedTarget.handle, selectedScope.handle, { action: 'redact' });if (sequence !== previewSequence) return;if (response.status === 401) return expired();const normalized = response.status === 201 ? preview(response.body, selectedTarget, selectedScope, Date.now()) : null;if (!normalized) { previewButton.disabled = false;setHidden(unavailable, false);announce('Display redaction preview unavailable.');return; }rows(previewTable, [['Target', normalized.target.label, TARGET_KIND_LABELS[normalized.target.targetKind]], ['Rows', String(normalized.expected.affectedRows.total), String(normalized.current.openNicknameHistoryRows) + ' open intervals'], ['Consequences', normalized.expected.privacyConsequences.join(', '), normalized.expected.durableEffects.join(', ')], ['Boundary', 'Redacted display values cannot be recovered', 'No rollback; confirm before preview expiry']]);authority = { scope: { ...selectedScope }, target: { ...selectedTarget }, handle: normalized.handle, expiresAt: normalized.expiresAt };setHidden(previewSurface, false);confirmButton.disabled = false;timer = window.setTimeout(() => { authority = null;confirmButton.disabled = true;previewButton.disabled = !selectedDetail;setHidden(previewSurface, true);announce('Display redaction preview expired. Request a fresh preview.'); }, Math.min(normalized.expiresAt - Date.now(), 2_147_483_647));announce('Display redaction preview ready. Confirmation is available until the preview expires.'); }
async function confirm() { const retained = authority;const selectedScope = scope();if (!retained || confirmButton.disabled || !selectedScope || !selectedTarget || selectedScope.handle !== retained.scope.handle || selectedTarget.handle !== retained.target.handle || retained.expiresAt <= Date.now()) { clearAuthority();return; }authority = null;confirmButton.disabled = true;if (timer !== null) window.clearTimeout(timer);timer = null;const sequence = ++confirmSequence;const response = await mutate(TARGETS_ENDPOINT + '/' + retained.target.handle + '/confirm', selectedScope.handle, { confirm: true, previewHandle: retained.handle });if (sequence !== confirmSequence) return;if (response.status === 401) return expired();const normalized = response.status === 200 ? result(response.body, retained.target) : null;if (!normalized) { setHidden(previewSurface, true);setHidden(unavailable, false);previewButton.disabled = !selectedDetail;announce('Display redaction confirmation unavailable. Request a fresh preview.');return; }rows(resultTable, [['Target', normalized.target.label, normalized.outcome], ['Rows', String(normalized.affectedRows.total), String(normalized.openNicknameHistoryRowsClosed) + ' intervals closed'], ['Evidence', normalized.evidence.auditEvent, normalized.redactedAt], ['Boundary', 'Redacted display values cannot be recovered', 'No rollback is available']]);setHidden(success, false);setHidden(previewSurface, true);clearDetail();void loadTargets();announce('Display data redacted.'); }
select.addEventListener('change', () => { setHidden(success, true);void loadTargets(); });refresh.addEventListener('click', () => void loadCatalog());targets.addEventListener('click', (event) => { const button = event.target?.closest?.('[data-display-index]'); if (!button || !targets.contains(button)) return; const entry = entries[Number(button.getAttribute('data-display-index'))]; if (!entry) return; setHidden(success, true); void loadDetail(entry); setTargetExpanded(button); });previewButton.addEventListener('click', () => void loadPreview());confirmButton.addEventListener('click', () => void confirm());setHidden(loading, true);setHidden(unavailable, true);setHidden(empty, true);setHidden(unselected, true);setHidden(success, true);
return { nav, view, load: loadCatalog, reset: () => { catalogSequence += 1;listSequence += 1;clearDetail();scopes = [];entries = [];select.replaceChildren(createElement('option', { value: '' }, 'Select a user scope'));select.disabled = true;targets.replaceChildren();resultTable.replaceChildren();setHidden(content, true);setHidden(empty, true);setHidden(unselected, true);setHidden(success, true);setHidden(view, true); } };
}
