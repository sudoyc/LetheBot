import { append, createElement, detailTable } from '/governance/memory-presentation.js';

const SCOPES_ENDPOINT = '/governance/api/v1/explain/scopes';
const TURNS_ENDPOINT = '/governance/api/v1/explain/turns';
const REFERENCE_PATTERN = /^[0-9a-f]{16}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATUSES = ['pending', 'running', 'completed', 'failed', 'aborted'];
const CONVERSATION_TYPES = ['private', 'group'];
const MAX_ENTRIES = 100;
const MAX_DETAIL_ITEMS = 32;

function exactObject(value, required, optional = []) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
const keys = Object.keys(value);
return required.every((key) => Object.hasOwn(value, key))
&& keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedText(value, maximum) {
return typeof value === 'string' && Array.from(value).length <= maximum
&& !Array.from(value).some((character) => {
const codePoint = character.codePointAt(0);
return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
});
}

function canonicalDate(value) {
if (typeof value !== 'string') return false;
const time = Date.parse(value);
return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function state(parent, id, className, role, title, description) {
const element = append(parent, 'section', { id, class: className, role, hidden: '' });
append(element, 'h2', {}, title);
append(element, 'p', {}, description);
return element;
}

function normalizeCatalog(value, now) {
if (!exactObject(value, ['entries', 'truncated'])
|| !Array.isArray(value.entries)
|| value.entries.length > MAX_ENTRIES
|| typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => exactObject(entry, [
'fingerprint', 'scopeKind', 'conversationType', 'label', 'handle', 'expiresAt',
])
&& REFERENCE_PATTERN.test(entry.fingerprint)
&& entry.scopeKind === 'conversation'
&& CONVERSATION_TYPES.includes(entry.conversationType)
&& boundedText(entry.label, 96)
&& OPAQUE_PATTERN.test(entry.handle)
&& Number.isSafeInteger(entry.expiresAt)
&& entry.expiresAt > now ? { ...entry } : null);
if (entries.some((entry) => entry === null)
|| new Set(entries.map((entry) => entry.fingerprint)).size !== entries.length
|| new Set(entries.map((entry) => entry.handle)).size !== entries.length) return null;
return { entries, truncated: value.truncated };
}

function normalizeTurn(value, now) {
if (!exactObject(value, [
'fingerprint', 'label', 'traceSource', 'status', 'startedAt', 'handle',
'handleExpiresAt',
], ['completedAt'])
|| !REFERENCE_PATTERN.test(value.fingerprint)
|| value.label !== 'Turn'
|| value.traceSource !== 'stored'
|| !STATUSES.includes(value.status)
|| !canonicalDate(value.startedAt)
|| (Object.hasOwn(value, 'completedAt') && !canonicalDate(value.completedAt))
|| OPAQUE_PATTERN.test(value.handle) === false
|| !Number.isSafeInteger(value.handleExpiresAt)
|| value.handleExpiresAt <= now) return null;
return { ...value };
}

function normalizePage(value, now) {
if (!exactObject(value, ['entries', 'truncated'])
|| !Array.isArray(value.entries)
|| value.entries.length > MAX_ENTRIES
|| typeof value.truncated !== 'boolean') return null;
const entries = value.entries.map((entry) => normalizeTurn(entry, now));
if (entries.some((entry) => entry === null)
|| new Set(entries.map((entry) => entry.fingerprint)).size !== entries.length
|| new Set(entries.map((entry) => entry.handle)).size !== entries.length) return null;
return { entries, truncated: value.truncated };
}

function validLabel(value) {
return exactObject(value, ['label', 'redacted', 'truncated'])
&& boundedText(value.label, 96)
&& typeof value.redacted === 'boolean'
&& typeof value.truncated === 'boolean';
}

function normalizeDetail(value, selected) {
if (!exactObject(value, ['turn', 'context', 'tools', 'toolsTruncated'], ['actionDecision'])
|| !exactObject(value.turn, [
'fingerprint', 'label', 'traceSource', 'status', 'startedAt',
], ['completedAt'])
|| value.turn.fingerprint !== selected.fingerprint
|| value.turn.label !== 'Turn'
|| value.turn.traceSource !== 'stored'
|| !STATUSES.includes(value.turn.status)
|| !canonicalDate(value.turn.startedAt)
|| (Object.hasOwn(value.turn, 'completedAt') && !canonicalDate(value.turn.completedAt))
|| !exactObject(value.context, [
'traceSource', 'candidateMemoryCount', 'selectedMemoryCount',
'rejectedMemoryCount', 'recentMessageCount', 'includedMemoryCount', 'filters',
'filtersTruncated', 'injectedIdentityFields', 'injectedIdentityFieldsTruncated',
], ['tokenBudget'])
|| value.context.traceSource !== 'stored') return null;
for (const key of [
'candidateMemoryCount', 'selectedMemoryCount', 'rejectedMemoryCount',
'recentMessageCount', 'includedMemoryCount',
]) if (!Number.isSafeInteger(value.context[key]) || value.context[key] < 0) return null;
if (value.context.selectedMemoryCount + value.context.rejectedMemoryCount
> value.context.candidateMemoryCount
|| !Array.isArray(value.context.filters)
|| value.context.filters.length > MAX_DETAIL_ITEMS
|| value.context.filters.some((entry) => !validLabel(entry))
|| typeof value.context.filtersTruncated !== 'boolean'
|| !Array.isArray(value.context.injectedIdentityFields)
|| value.context.injectedIdentityFields.length > MAX_DETAIL_ITEMS
|| value.context.injectedIdentityFields.some((entry) => !validLabel(entry))
|| typeof value.context.injectedIdentityFieldsTruncated !== 'boolean'
|| !Array.isArray(value.tools)
|| value.tools.length > MAX_DETAIL_ITEMS
|| typeof value.toolsTruncated !== 'boolean') return null;
if (Object.hasOwn(value.context, 'tokenBudget')) {
const budget = value.context.tokenBudget;
if (!exactObject(budget, ['max', 'used', 'breakdown'])
|| !exactObject(budget.breakdown, ['recentMessages', 'memory', 'identity', 'system'])) return null;
for (const count of [budget.max, budget.used, ...Object.values(budget.breakdown)]) {
if (!Number.isSafeInteger(count) || count < 0) return null;
}
if (budget.used > budget.max) return null;
}
if (Object.hasOwn(value, 'actionDecision')) {
const decision = value.actionDecision;
if (!exactObject(decision, [
'decidedBy', 'riskLevel', 'confidence', 'evaluatorRequired', 'actionCount',
'actionTypes', 'actionTypesTruncated', 'reasonCount', 'suppressorCount',
'executions', 'executionsTruncated',
], ['evaluatorPassed'])
|| !boundedText(decision.decidedBy, 32)
|| !boundedText(decision.riskLevel, 32)
|| typeof decision.confidence !== 'number'
|| decision.confidence < 0 || decision.confidence > 1
|| typeof decision.evaluatorRequired !== 'boolean'
|| (Object.hasOwn(decision, 'evaluatorPassed')
&& typeof decision.evaluatorPassed !== 'boolean')
|| !Number.isSafeInteger(decision.actionCount) || decision.actionCount < 0
|| !Array.isArray(decision.actionTypes) || decision.actionTypes.length > MAX_DETAIL_ITEMS
|| decision.actionTypes.some((entry) => !boundedText(entry, 32))
|| typeof decision.actionTypesTruncated !== 'boolean'
|| !Number.isSafeInteger(decision.reasonCount) || decision.reasonCount < 0
|| !Number.isSafeInteger(decision.suppressorCount) || decision.suppressorCount < 0
|| !Array.isArray(decision.executions) || decision.executions.length > MAX_DETAIL_ITEMS
|| typeof decision.executionsTruncated !== 'boolean') return null;
for (const execution of decision.executions) {
if (!exactObject(execution, [
'actionType', 'status', 'executedMessage', 'executedMemory', 'scheduledJob',
'errorCodeRedacted', 'errorCodeTruncated', 'executedAt',
], ['effect', 'downgradedFrom', 'errorCode'])
|| !boundedText(execution.actionType, 32)
|| !boundedText(execution.status, 32)
|| typeof execution.executedMessage !== 'boolean'
|| typeof execution.executedMemory !== 'boolean'
|| typeof execution.scheduledJob !== 'boolean'
|| typeof execution.errorCodeRedacted !== 'boolean'
|| typeof execution.errorCodeTruncated !== 'boolean'
|| (Object.hasOwn(execution, 'effect') && !boundedText(execution.effect, 32))
|| (Object.hasOwn(execution, 'downgradedFrom')
&& !boundedText(execution.downgradedFrom, 32))
|| (Object.hasOwn(execution, 'errorCode') && !boundedText(execution.errorCode, 96))
|| !canonicalDate(execution.executedAt)) return null;
}
}
for (const tool of value.tools) {
if (!exactObject(tool, [
'toolName', 'toolNameRedacted', 'toolNameTruncated', 'requestedBy', 'status',
'errorCodeRedacted', 'errorCodeTruncated', 'secretsRedacted', 'createdAt',
], ['errorCode', 'executionTimeMs'])
|| !boundedText(tool.toolName, 96)
|| typeof tool.toolNameRedacted !== 'boolean'
|| typeof tool.toolNameTruncated !== 'boolean'
|| !['pi', 'evaluator', 'user', 'system'].includes(tool.requestedBy)
|| !boundedText(tool.status, 32)
|| typeof tool.errorCodeRedacted !== 'boolean'
|| typeof tool.errorCodeTruncated !== 'boolean'
|| typeof tool.secretsRedacted !== 'boolean'
|| (Object.hasOwn(tool, 'errorCode') && !boundedText(tool.errorCode, 96))
|| (Object.hasOwn(tool, 'executionTimeMs')
&& (!Number.isSafeInteger(tool.executionTimeMs) || tool.executionTimeMs < 0))
|| !canonicalDate(tool.createdAt)) return null;
}
return value;
}

function appendRows(table, rows) {
table.replaceChildren();
for (const [label, primary, secondary] of rows) {
const row = append(table, 'div');
append(row, 'dt', {}, label);
const value = append(row, 'dd');
append(value, 'span', { class: 'worker-heartbeat-primary' }, primary);
append(value, 'span', { class: 'worker-heartbeat-secondary' }, secondary);
}
}

export function createExplainFeature(
elements,
setHidden,
requestJson,
showSessionExpired,
announce,
) {
const nav = createElement('button', {
id: 'explain-nav',
class: 'nav-item',
type: 'button','aria-controls': 'explain-view',
}, 'Explain');
elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', {
id: 'explain-view',class: 'memory-view','aria-labelledby': 'explain-title',hidden: '',
});
elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });
const title = append(toolbar, 'div');
append(title, 'p', { class: 'eyebrow' }, 'Stored trace evidence');
append(title, 'h1', { id: 'explain-title' }, 'Explain');
const refresh = append(toolbar, 'button', {
id: 'explain-refresh-button',class: 'button button-secondary',type: 'button',
}, 'Refresh');
const scopeBand = append(view, 'section', {
class: 'memory-scope-band','aria-labelledby': 'explain-scope-title',
});
const scopeTitle = append(scopeBand, 'div');
append(scopeTitle, 'p', { class: 'eyebrow' }, 'Exact conversation scope');
append(scopeTitle, 'h2', { id: 'explain-scope-title' }, 'Stored turns');
const control = append(scopeBand, 'div');
append(control, 'label', { for: 'explain-scope-select' }, 'Conversation scope');
const select = append(control, 'select', { id: 'explain-scope-select', disabled: '' });
append(select, 'option', { value: '' }, 'Select a scope');
const loading = state(view, 'explain-loading', 'empty-band', 'status', 'Loading Explain', 'Stored trace evidence is being refreshed.');
const unavailable = state(view, 'explain-unavailable', 'error-band', 'alert', 'Explain unavailable', 'Refresh stored trace evidence.');
const empty = state(view, 'explain-empty', 'empty-band', 'status', 'No stored turns', 'No explainable turns exist in this scope.');
const content = append(view, 'section', { id: 'explain-content', class: 'worker-heartbeats-content', hidden: '' });
const count = append(content, 'p', { class: 'memory-records-count' }, 'Showing -- turns');
const list = append(content, 'div', { id: 'explain-turns', class: 'memory-records-list' });
const detail = append(view, 'section', { id: 'explain-detail', 'aria-labelledby': 'explain-detail-title' });
append(detail, 'h2', { id: 'explain-detail-title' }, 'Turn evidence');
const detailUnselected = state(detail, 'explain-detail-unselected', 'empty-band', 'status', 'No turn selected', 'Select a stored turn.');
const detailLoading = state(detail, 'explain-detail-loading', 'empty-band', 'status', 'Loading turn evidence', 'Stored evidence is being read.');
const detailUnavailable = state(detail, 'explain-detail-unavailable', 'error-band', 'alert', 'Turn evidence unavailable', 'Refresh Explain before retrying.');
const detailStale = state(detail, 'explain-detail-stale', 'error-band', 'alert', 'Turn evidence changed', 'Refresh Explain before continuing.');
const detailContent = append(detail, 'div', { id: 'explain-detail-content', class: 'worker-heartbeats-content', hidden: '' });
const turnTable = detailTable(detailContent, 'Turn', ['Status', 'Context', 'Decision', 'Tools']);
let scopes = [];
let turns = [];
let selectedFingerprint = null;
let catalogSequence = 0;
let turnsSequence = 0;
let detailSequence = 0;

function hideMain() {
for (const element of [loading, unavailable, empty, content]) setHidden(element, true);
}
function hideDetail() {
for (const element of [detailUnselected, detailLoading, detailUnavailable, detailStale, detailContent]) setHidden(element, true);
}
function selectedScope() {
const index = Number(select.value) - 1;
return Number.isInteger(index) && scopes[index] ? scopes[index] : null;
}
function resetDetail() {
detailSequence += 1;
selectedFingerprint = null;
turnTable.replaceChildren();
hideDetail();
setHidden(detailUnselected, false);
}
function renderTurns(page) {
turns = page.entries;
list.replaceChildren();
for (const [index, turn] of turns.entries()) {
const button = append(list, 'button', {
class: 'memory-record-row',type: 'button','data-explain-index': String(index),
'aria-expanded': 'false',
});
append(button, 'span', { class: 'memory-record-primary' }, turn.label + ' - ' + turn.status);
append(button, 'span', { class: 'memory-record-secondary' }, turn.startedAt);
}
count.textContent = 'Showing ' + turns.length + (turns.length === 1 ? ' turn' : ' turns')
+ (page.truncated ? ' - first 100 only' : '');
hideMain();
setHidden(turns.length ? content : empty, false);
resetDetail();
}
async function loadTurns() {
const scope = selectedScope();
if (!scope) {
turns = [];
list.replaceChildren();
hideMain();
setHidden(empty, false);
resetDetail();
return;
}
const sequence = ++turnsSequence;
hideMain();
setHidden(loading, false);
const response = await requestJson(TURNS_ENDPOINT, {
headers: { 'X-LetheBot-Scope': scope.handle },
});
if (sequence !== turnsSequence) return;
if (response.status === 401) return showSessionExpired();
if (response.status !== 200) {
hideMain();setHidden(unavailable, false);announce('Explain turns unavailable.');return;
}
const page = normalizePage(response.body, Date.now());
if (!page) {
hideMain();setHidden(unavailable, false);announce('Explain turns malformed.');return;
}
renderTurns(page);
announce(page.entries.length ? 'Explain turns updated.' : 'No stored turns.');
}
async function loadCatalog() {
const sequence = ++catalogSequence;
turnsSequence += 1;
resetDetail();
hideMain();setHidden(loading, false);select.disabled = true;refresh.disabled = true;
const response = await requestJson(SCOPES_ENDPOINT);
if (sequence !== catalogSequence) return;
refresh.disabled = false;
if (response.status === 401) return showSessionExpired();
const catalog = response.status === 200 ? normalizeCatalog(response.body, Date.now()) : null;
if (!catalog) {
hideMain();setHidden(unavailable, false);select.disabled = scopes.length === 0;
announce('Explain scopes unavailable.');return;
}
scopes = catalog.entries;
select.replaceChildren(createElement('option', { value: '' }, 'Select a scope'));
for (const [index, scope] of scopes.entries()) append(select, 'option', {
value: String(index + 1),
}, scope.label + ' - ' + scope.conversationType);
select.disabled = scopes.length === 0;
hideMain();setHidden(empty, false);
announce(scopes.length ? 'Explain scopes updated.' : 'No Explain scopes.');
}
async function loadDetail(turn) {
const scope = selectedScope();
if (!scope) return;
const sequence = ++detailSequence;
hideDetail();setHidden(detailLoading, false);
const response = await requestJson(TURNS_ENDPOINT + '/' + turn.handle, {
headers: { 'X-LetheBot-Scope': scope.handle },
});
if (sequence !== detailSequence) return;
if (response.status === 401) return showSessionExpired();
if (response.status !== 200) {
hideDetail();setHidden(response.status === 404 ? detailStale : detailUnavailable, false);
announce('Turn evidence unavailable.');return;
}
const normalized = normalizeDetail(response.body, turn);
if (!normalized) {
hideDetail();setHidden(detailStale, false);announce('Turn evidence malformed.');return;
}
const context = normalized.context;
const decision = normalized.actionDecision;
appendRows(turnTable, [
['Status', normalized.turn.status, normalized.turn.startedAt],
['Context', context.selectedMemoryCount + ' selected / ' + context.candidateMemoryCount + ' candidates', context.includedMemoryCount + ' included memory'],
['Decision', decision ? decision.decidedBy + ' - ' + decision.riskLevel : 'No stored decision', decision ? decision.actionCount + ' actions' : 'Read-only evidence'],
['Tools', String(normalized.tools.length), normalized.toolsTruncated ? 'First 32 only' : 'Complete bounded list'],
]);
hideDetail();setHidden(detailContent, false);announce('Turn evidence updated.');
}

select.addEventListener('change', () => void loadTurns());
refresh.addEventListener('click', () => void loadCatalog());
list.addEventListener('click', (event) => {
const button = event.target?.closest?.('[data-explain-index]');
if (!button || !list.contains(button)) return;
const turn = turns[Number(button.getAttribute('data-explain-index'))];
if (!turn) return;
selectedFingerprint = turn.fingerprint;
for (const control of list.querySelectorAll('[data-explain-index]')) {
control.setAttribute('aria-expanded', control === button ? 'true' : 'false');
}
void loadDetail(turn);
});
resetDetail();
hideMain();setHidden(empty, false);
return {
nav,
view,
load: loadCatalog,
reset: () => {
catalogSequence += 1;turnsSequence += 1;detailSequence += 1;
scopes = [];turns = [];selectedFingerprint = null;
select.replaceChildren(createElement('option', { value: '' }, 'Select a scope'));
select.disabled = true;list.replaceChildren();turnTable.replaceChildren();
hideMain();hideDetail();setHidden(view, true);
},
};
}
