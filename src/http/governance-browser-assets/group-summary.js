import { append, createElement, detailTable } from '/governance/memory-presentation.js';

const SCOPES_ENDPOINT = '/governance/api/v1/group-summary/scopes';
const POLICY_ENDPOINT = '/governance/api/v1/group-summary/policy';
const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STATES = ['enabled', 'disabled'];
const ENABLE_EFFECTS = ['group_summary_policy_upsert', 'audit_event_append'];
const DISABLE_EFFECTS = ['group_summary_policy_upsert', 'pending_group_summary_jobs_terminalized', 'audit_event_append'];
const ENABLE_CONSEQUENCES = ['policy_generation_advanced', 'pre_enable_sources_excluded', 'group_summary_generation_and_retrieval_enabled'];
const DISABLE_CONSEQUENCES = ['policy_generation_advanced', 'group_summary_generation_and_retrieval_disabled', 'pending_group_summary_jobs_canceled'];

function exact(value, required) {
return Boolean(value && typeof value === 'object' && !Array.isArray(value)
&& required.every((key) => Object.hasOwn(value, key))
&& Object.keys(value).every((key) => required.includes(key)));
}
function list(value, expected) {
return Array.isArray(value) && value.length === expected.length
&& value.every((entry, index) => entry === expected[index]);
}
function dateOrNull(value) {
if (value === null) return true;if (typeof value !== 'string') return false;
const time = Date.parse(value);return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function state(parent, id, className, role, title, description) {
const element = append(parent, 'section', { id, class: className, role, hidden: '' });
append(element, 'h2', {}, title);append(element, 'p', {}, description);return element;
}
function catalog(value, now) {
if (!exact(value, ['entries', 'truncated']) || !Array.isArray(value.entries)
|| value.entries.length > 100 || typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => exact(entry, ['fingerprint', 'scopeKind', 'label', 'handle', 'expiresAt'])
&& REFERENCE_PATTERN.test(entry.fingerprint) && entry.scopeKind === 'group'
&& entry.label === 'Group summary policy' && OPAQUE_PATTERN.test(entry.handle)
&& Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now ? { ...entry } : null);
return entries.some((entry) => entry === null)
|| new Set(entries.map((entry) => entry.handle)).size !== entries.length ? null
: { entries, truncated: value.truncated };
}
function policy(value) {
return exact(value, ['state', 'stored', 'generation', 'eligibleAfter', 'createdAt', 'updatedAt'])
&& STATES.includes(value.state) && typeof value.stored === 'boolean'
&& (value.generation === null || (Number.isSafeInteger(value.generation) && value.generation > 0))
&& dateOrNull(value.eligibleAfter) && dateOrNull(value.createdAt) && dateOrNull(value.updatedAt)
&& (value.stored || (value.state === 'disabled' && value.generation === null
&& value.eligibleAfter === null && value.createdAt === null && value.updatedAt === null)) ? value : null;
}
function expectedLists(target) {
return target === 'enabled'
? [ENABLE_EFFECTS, ENABLE_CONSEQUENCES]
: [DISABLE_EFFECTS, DISABLE_CONSEQUENCES];
}
function preview(value, selected, target, now) {
const [effects, consequences] = expectedLists(target);
if (!exact(value, ['action', 'current', 'expected', 'rollback', 'previewDigest', 'previewHandle', 'previewExpiresAt'])
|| value.action !== 'group.summary_policy.change'
|| !exact(value.current, ['state', 'stored', 'version']) || !STATES.includes(value.current.state)
|| value.current.state === target || typeof value.current.stored !== 'boolean'
|| !exact(value.current.version, ['generation', 'updatedAt'])
|| (value.current.version.generation !== null && (!Number.isSafeInteger(value.current.version.generation) || value.current.version.generation < 1))
|| !dateOrNull(value.current.version.updatedAt)
|| !exact(value.expected, ['state', 'generation', 'durableEffects', 'enforcementConsequences'])
|| value.expected.state !== target || !Number.isSafeInteger(value.expected.generation)
|| value.expected.generation !== (value.current.version.generation ?? 0) + 1
|| !list(value.expected.durableEffects, effects) || !list(value.expected.enforcementConsequences, consequences)
|| !exact(value.rollback, ['supported', 'targetState', 'boundary'])
|| value.rollback.supported !== true || value.rollback.targetState !== value.current.state
|| value.rollback.boundary !== 'separate_group_summary_policy_change_confirmation_required'
|| !DIGEST_PATTERN.test(value.previewDigest) || !OPAQUE_PATTERN.test(value.previewHandle)
|| !Number.isSafeInteger(value.previewExpiresAt) || value.previewExpiresAt <= now
|| value.previewExpiresAt > selected.expiresAt) return null;
return { current: value.current, expected: value.expected, rollback: value.rollback,
handle: value.previewHandle, expiresAt: value.previewExpiresAt };
}
function result(value, target) {
const [effects, consequences] = expectedLists(target);
return exact(value, ['action', 'outcome', 'current', 'durableEffects', 'enforcementConsequences', 'evidence', 'rollback'])
&& value.action === 'group.summary_policy.change' && value.outcome === 'updated'
&& exact(value.current, ['state', 'stored', 'version', 'eligibleAfter'])
&& value.current.state === target && value.current.stored === true
&& exact(value.current.version, ['generation', 'updatedAt'])
&& Number.isSafeInteger(value.current.version.generation) && value.current.version.generation > 0
&& dateOrNull(value.current.version.updatedAt) && dateOrNull(value.current.eligibleAfter)
&& list(value.durableEffects, effects)
&& list(value.enforcementConsequences, consequences)
&& exact(value.evidence, ['auditEvent', 'generation', 'updatedAt', 'canceledJobCount'])
&& value.evidence.auditEvent === 'group.summary_policy_changed'
&& value.evidence.generation === value.current.version.generation
&& dateOrNull(value.evidence.updatedAt) && Number.isSafeInteger(value.evidence.canceledJobCount)
&& value.evidence.canceledJobCount >= 0
&& exact(value.rollback, ['supported', 'targetState', 'boundary'])
&& value.rollback.supported === true && value.rollback.targetState !== target
&& value.rollback.boundary === 'separate_group_summary_policy_change_confirmation_required' ? value : null;
}
function rows(table, values) {
table.replaceChildren();for (const [label, primary, secondary] of values) {
const row = append(table, 'div');append(row, 'dt', {}, label);const cell = append(row, 'dd');
append(cell, 'span', { class: 'worker-heartbeat-primary' }, primary);
append(cell, 'span', { class: 'worker-heartbeat-secondary' }, secondary);
}}

export function createGroupSummaryFeature(elements, setHidden, requestJson, mutate, expired, announce) {
const nav = createElement('button', { id: 'group-summary-nav', class: 'nav-item', type: 'button', 'aria-controls': 'group-summary-view' }, 'Group policy');
elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', { id: 'group-summary-view', class: 'memory-view', 'aria-labelledby': 'group-summary-title', hidden: '' });
elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });const heading = append(toolbar, 'div');
append(heading, 'p', { class: 'eyebrow' }, 'Generation and retrieval');append(heading, 'h1', { id: 'group-summary-title' }, 'Group summary policy');
const refresh = append(toolbar, 'button', { class: 'button button-secondary', type: 'button' }, 'Refresh');
const controls = append(view, 'section', { class: 'memory-scope-band', 'aria-labelledby': 'group-summary-controls-title' });
append(controls, 'h2', { id: 'group-summary-controls-title' }, 'Exact group scope');
const select = append(controls, 'select', { id: 'group-summary-scope-select', disabled: '' });append(select, 'option', { value: '' }, 'Select a group scope');
const target = append(controls, 'select', { id: 'group-summary-target-select' });
for (const value of STATES) append(target, 'option', { value }, value);
const previewButton = append(controls, 'button', { id: 'group-summary-preview-button', class: 'button button-primary', type: 'button', disabled: '' }, 'Preview change');
const loading = state(view, 'group-summary-loading', 'empty-band', 'status', 'Loading group policy', 'Policy evidence is being refreshed.');
const unavailable = state(view, 'group-summary-unavailable', 'error-band', 'alert', 'Group policy unavailable', 'Refresh before continuing.');
const current = append(view, 'div', { class: 'worker-heartbeats-content', hidden: '' });const currentTable = detailTable(current, 'Current policy', ['State', 'Generation', 'Eligibility']);
const previewSurface = append(view, 'div', { id: 'group-summary-preview', class: 'worker-heartbeats-content', hidden: '' });
const previewTable = detailTable(previewSurface, 'Policy change preview', ['Transition', 'Generation', 'Effects', 'Boundary']);
const confirmButton = append(previewSurface, 'button', { id: 'group-summary-confirm-button', class: 'button button-primary', type: 'button', disabled: '' }, 'Confirm policy change');
const success = state(view, 'group-summary-success', 'worker-heartbeats-content', 'status', 'Group policy updated', 'The bounded policy change was confirmed.');
const resultTable = detailTable(success, 'Policy change result', ['State', 'Generation', 'Evidence', 'Boundary']);
let scopes = [];let authority = null;let catalogSequence = 0;let readSequence = 0;let previewSequence = 0;let confirmSequence = 0;let timer = null;
function selected() { return scopes[Number(select.value) - 1] || null; }
function clear() { previewSequence += 1;confirmSequence += 1;if (timer !== null) window.clearTimeout(timer);timer = null;authority = null;confirmButton.disabled = true;previewTable.replaceChildren();setHidden(previewSurface, true); }
function update() { previewButton.disabled = !selected() || authority !== null; }
async function loadPolicy() {
const scope = selected();clear();if (!scope) { setHidden(current, true);update();return; }
const sequence = ++readSequence;setHidden(loading, false);const response = await requestJson(POLICY_ENDPOINT, { headers: { 'X-LetheBot-Scope': scope.handle } });
if (sequence !== readSequence) return;setHidden(loading, true);if (response.status === 401) return expired();const normalized = response.status === 200 ? policy(response.body) : null;
if (!normalized) { setHidden(unavailable, false);announce('Group policy unavailable.');return; }
rows(currentTable, [['State', normalized.state, normalized.stored ? 'Stored policy' : 'Implicit default'], ['Generation', String(normalized.generation ?? 0), String(normalized.updatedAt ?? 'Never')], ['Eligibility', String(normalized.eligibleAfter ?? 'Not eligible'), 'Bounded group policy']]);
setHidden(unavailable, true);setHidden(current, false);update();announce('Group policy updated.');
}
async function loadCatalog() {
const sequence = ++catalogSequence;readSequence += 1;clear();refresh.disabled = true;select.disabled = true;setHidden(loading, false);const response = await requestJson(SCOPES_ENDPOINT);
if (sequence !== catalogSequence) return;refresh.disabled = false;setHidden(loading, true);if (response.status === 401) return expired();const normalized = response.status === 200 ? catalog(response.body, Date.now()) : null;
if (!normalized) { setHidden(unavailable, false);announce('Group policy scopes unavailable.');return; }
scopes = normalized.entries;select.replaceChildren(createElement('option', { value: '' }, 'Select a group scope'));
for (const [index, entry] of scopes.entries()) append(select, 'option', { value: String(index + 1) }, entry.label);
select.disabled = scopes.length === 0;setHidden(unavailable, true);setHidden(current, true);update();announce('Group policy scopes updated.');
}
async function loadPreview() {
const scope = selected();if (!scope || previewButton.disabled) return;clear();const sequence = ++previewSequence;const targetState = target.value;previewButton.disabled = true;
const response = await mutate(POLICY_ENDPOINT, scope.handle, { action: 'change', targetState });if (sequence !== previewSequence) return;if (response.status === 401) return expired();
const normalized = response.status === 201 ? preview(response.body, scope, targetState, Date.now()) : null;if (!normalized) { previewButton.disabled = false;announce('Group policy preview unavailable.');return; }
rows(previewTable, [['Transition', normalized.current.state, normalized.expected.state], ['Generation', String(normalized.expected.generation), String(normalized.current.version.generation ?? 0)], ['Effects', normalized.expected.enforcementConsequences.join(', '), normalized.expected.durableEffects.join(', ')], ['Boundary', normalized.rollback.boundary, 'Separate confirmation required']]);
authority = { scope: { ...scope }, target: targetState, handle: normalized.handle, expiresAt: normalized.expiresAt };setHidden(previewSurface, false);confirmButton.disabled = false;
timer = window.setTimeout(() => { authority = null;confirmButton.disabled = true;setHidden(previewSurface, true);announce('Group policy preview expired.'); }, Math.min(normalized.expiresAt - Date.now(), 2_147_483_647));announce('Group policy preview ready.');
}
async function confirm() {
const retained = authority;const scope = selected();if (!retained || confirmButton.disabled || !scope || scope.handle !== retained.scope.handle || retained.expiresAt <= Date.now()) { clear();return; }
authority = null;confirmButton.disabled = true;if (timer !== null) window.clearTimeout(timer);timer = null;const sequence = ++confirmSequence;
const response = await mutate(POLICY_ENDPOINT + '/confirm', scope.handle, { confirm: true, previewHandle: retained.handle, targetState: retained.target });if (sequence !== confirmSequence) return;if (response.status === 401) return expired();
const normalized = response.status === 200 ? result(response.body, retained.target) : null;if (!normalized) { setHidden(previewSurface, true);announce('Group policy confirmation unavailable.');return; }
rows(resultTable, [['State', normalized.current.state, normalized.outcome], ['Generation', String(normalized.current.version.generation), String(normalized.current.version.updatedAt)], ['Evidence', normalized.evidence.auditEvent, String(normalized.evidence.canceledJobCount) + ' jobs canceled'], ['Boundary', normalized.rollback.boundary, normalized.enforcementConsequences.join(', ')]]);
setHidden(previewSurface, true);setHidden(success, false);announce('Group policy updated.');void loadPolicy();
}
select.addEventListener('change', () => void loadPolicy());refresh.addEventListener('click', () => void loadCatalog());previewButton.addEventListener('click', () => void loadPreview());confirmButton.addEventListener('click', () => void confirm());setHidden(loading, true);setHidden(unavailable, true);setHidden(success, true);update();
return { nav, view, load: loadCatalog, reset: () => { catalogSequence += 1;readSequence += 1;clear();scopes = [];select.replaceChildren(createElement('option', { value: '' }, 'Select a group scope'));select.disabled = true;currentTable.replaceChildren();resultTable.replaceChildren();setHidden(current, true);setHidden(success, true);setHidden(view, true); } };
}
