import { append, createElement, detailTable } from '/governance/memory-presentation.js';
import { createRetentionPanel } from '/governance/retention.js';

const UNLINK_ENDPOINT = '/governance/api/v1/identity/platform-accounts/unlink';
const OPERATIONS_ENDPOINT = '/governance/api/v1/operations';
const RESTORE_ENDPOINT = OPERATIONS_ENDPOINT + '/restore';
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REFERENCE = /^[0-9a-f]{16}$/;
const QQ_ACCOUNT = /^[1-9][0-9]{4,11}$/;

function exact(value, required) {
return Boolean(value && typeof value === 'object' && !Array.isArray(value)
&& required.every((key) => Object.hasOwn(value, key))
&& Object.keys(value).every((key) => required.includes(key)));
}
function list(value, expected) { return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function date(value) { if (typeof value !== 'string') return false;const time = Date.parse(value);return Number.isFinite(time) && new Date(time).toISOString() === value; }
function state(parent, id, className, role, title, description) { const element = append(parent, 'section', { id, class: className, role, hidden: '' });append(element, 'h2', {}, title);append(element, 'p', {}, description);return element; }
function rows(table, values) { table.replaceChildren();for (const [label, primary, secondary] of values) { const row = append(table, 'div');append(row, 'dt', {}, label);const cell = append(row, 'dd');append(cell, 'span', { class: 'worker-heartbeat-primary' }, primary);append(cell, 'span', { class: 'worker-heartbeat-secondary' }, secondary); } }

const UNLINK_EFFECTS = ['platform_account_status_disabled', 'audit_event_append'];
const IDENTITY_CONSEQUENCES = ['future_identity_resolution_blocked'];
const PRIVACY_CONSEQUENCES = ['platform_account_mapping_retained'];
function account(value, status) {
return exact(value, ['fingerprint', 'platform', 'accountType', 'verifiedLevel', 'status', 'firstSeenAt', 'lastSeenAt'])
&& REFERENCE.test(value.fingerprint) && value.platform === 'qq'
&& ['private', 'group_member', 'temp_session'].includes(value.accountType)
&& ['owner_verified', 'self_claimed', 'observed'].includes(value.verifiedLevel)
&& value.status === status && date(value.firstSeenAt) && date(value.lastSeenAt) ? value : null;
}
function unlinkPreview(value, now) {
if (!exact(value, ['action', 'account', 'current', 'expected', 'rollback', 'previewDigest', 'resourceHandle', 'resourceExpiresAt', 'previewHandle', 'previewExpiresAt'])
|| value.action !== 'identity.platform_account.unlink' || !account(value.account, 'active')
|| !exact(value.current, ['snapshotFingerprint']) || !DIGEST.test(value.current.snapshotFingerprint)
|| !exact(value.expected, ['status', 'durableEffects', 'identityConsequences', 'privacyConsequences'])
|| value.expected.status !== 'disabled' || !list(value.expected.durableEffects, UNLINK_EFFECTS)
|| !list(value.expected.identityConsequences, IDENTITY_CONSEQUENCES) || !list(value.expected.privacyConsequences, PRIVACY_CONSEQUENCES)
|| !exact(value.rollback, ['supported', 'boundary']) || value.rollback.supported !== false
|| value.rollback.boundary !== 'platform_account_relink_not_available'
|| !DIGEST.test(value.previewDigest) || !OPAQUE.test(value.resourceHandle) || !OPAQUE.test(value.previewHandle)
|| !integer(value.resourceExpiresAt) || !integer(value.previewExpiresAt)
|| value.resourceExpiresAt <= now || value.previewExpiresAt <= now
|| value.previewExpiresAt > value.resourceExpiresAt) return null;
return value;
}
function unlinkResult(value, expectedFingerprint) {
return exact(value, ['action', 'outcome', 'account', 'affectedRows', 'disabledAt', 'durableEffects', 'identityConsequences', 'privacyConsequences', 'evidence', 'rollback'])
&& value.action === 'identity.platform_account.unlink' && value.outcome === 'unlinked'
&& account(value.account, 'disabled') && value.account.fingerprint === expectedFingerprint
&& exact(value.affectedRows, ['platformAccounts']) && value.affectedRows.platformAccounts === 1
&& date(value.disabledAt) && list(value.durableEffects, UNLINK_EFFECTS)
&& list(value.identityConsequences, IDENTITY_CONSEQUENCES) && list(value.privacyConsequences, PRIVACY_CONSEQUENCES)
&& exact(value.evidence, ['auditEvent', 'reasonCode'])
&& value.evidence.auditEvent === 'identity.platform_account.unlinked'
&& value.evidence.reasonCode === 'governance_http_platform_account_unlink_confirmed'
&& exact(value.rollback, ['supported', 'boundary']) && value.rollback.supported === false
&& value.rollback.boundary === 'platform_account_relink_not_available' ? value : null;
}

export function createIdentityFeature(elements, setHidden, mutate, expired, announce) {
const nav = createElement('button', { id: 'identity-nav', class: 'nav-item', type: 'button', 'aria-controls': 'identity-view' }, 'Identity');elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', { id: 'identity-view', class: 'memory-view', 'aria-labelledby': 'identity-title', hidden: '' });elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });const heading = append(toolbar, 'div');append(heading, 'p', { class: 'eyebrow' }, 'Future identity resolution');append(heading, 'h1', { id: 'identity-title' }, 'Platform account unlink');
const controls = append(view, 'section', { class: 'memory-scope-band', 'aria-labelledby': 'identity-controls-title' });append(controls, 'h2', { id: 'identity-controls-title' }, 'Exact QQ account');
const input = append(controls, 'input', { id: 'identity-account-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '12', 'aria-label': 'QQ platform account ID' });
const previewButton = append(controls, 'button', { id: 'identity-preview-button', class: 'button button-primary', type: 'button' }, 'Preview unlink');
const unavailable = state(view, 'identity-unavailable', 'error-band', 'alert', 'Unlink unavailable', 'Enter an active exact account and preview again.');
const previewSurface = append(view, 'section', { id: 'identity-preview', class: 'worker-heartbeats-content', hidden: '' });const previewTable = detailTable(previewSurface, 'Unlink preview', ['Account', 'Transition', 'Consequences', 'Boundary']);
const confirmButton = append(previewSurface, 'button', { id: 'identity-confirm-button', class: 'button button-primary', type: 'button', disabled: '' }, 'Confirm unlink');
const success = state(view, 'identity-success', 'worker-heartbeats-content', 'status', 'Platform account unlinked', 'Future identity resolution is blocked for this mapping.');const resultTable = detailTable(success, 'Unlink result', ['Account', 'State', 'Evidence', 'Boundary']);
let authority = null;let previewSequence = 0;let confirmSequence = 0;let timer = null;
function clear() { previewSequence += 1;confirmSequence += 1;if (timer !== null) window.clearTimeout(timer);timer = null;authority = null;confirmButton.disabled = true;previewButton.disabled = false;previewTable.replaceChildren();setHidden(previewSurface, true); }
async function preview() { const platformAccountId = input.value;if (!QQ_ACCOUNT.test(platformAccountId)) { announce('Enter a valid QQ account ID.');return; }clear();previewButton.disabled = true;const sequence = ++previewSequence;const response = await mutate(UNLINK_ENDPOINT, { action: 'unlink', platform: 'qq', platformAccountId });input.value = '';if (sequence !== previewSequence) return;previewButton.disabled = false;if (response.status === 401) return expired();const normalized = response.status === 201 ? unlinkPreview(response.body, Date.now()) : null;if (!normalized) { setHidden(unavailable, false);announce('Platform account unlink preview unavailable.');return; }setHidden(unavailable, true);rows(previewTable, [['Account', normalized.account.platform, normalized.account.accountType], ['Transition', normalized.account.status, normalized.expected.status], ['Consequences', normalized.expected.identityConsequences.join(', '), normalized.expected.privacyConsequences.join(', ')], ['Boundary', normalized.rollback.boundary, 'No browser relink']]);authority = { resource: normalized.resourceHandle, preview: normalized.previewHandle, expiresAt: normalized.previewExpiresAt, fingerprint: normalized.account.fingerprint };previewButton.disabled = true;setHidden(previewSurface, false);confirmButton.disabled = false;timer = window.setTimeout(() => { authority = null;previewButton.disabled = false;confirmButton.disabled = true;setHidden(previewSurface, true);announce('Platform account unlink preview expired.'); }, Math.min(normalized.previewExpiresAt - Date.now(), 2_147_483_647));announce('Platform account unlink preview ready.'); }
async function confirm() { const retained = authority;if (!retained || confirmButton.disabled || retained.expiresAt <= Date.now()) { clear();return; }authority = null;confirmButton.disabled = true;if (timer !== null) window.clearTimeout(timer);timer = null;const sequence = ++confirmSequence;const response = await mutate(UNLINK_ENDPOINT + '/confirm', { confirm: true, resourceHandle: retained.resource, previewHandle: retained.preview });if (sequence !== confirmSequence) return;if (response.status === 401) return expired();const normalized = response.status === 200 ? unlinkResult(response.body, retained.fingerprint) : null;previewButton.disabled = false;setHidden(previewSurface, true);if (!normalized) { announce('Platform account unlink confirmation unavailable.');return; }rows(resultTable, [['Account', normalized.account.platform, normalized.account.accountType], ['State', normalized.account.status, normalized.outcome], ['Evidence', normalized.evidence.auditEvent, normalized.disabledAt], ['Boundary', normalized.rollback.boundary, normalized.identityConsequences.join(', ')]]);setHidden(success, false);announce('Platform account unlinked.'); }
input.addEventListener('input', clear);previewButton.addEventListener('click', () => void preview());confirmButton.addEventListener('click', () => void confirm());setHidden(unavailable, true);setHidden(success, true);
return { nav, view, load: () => { setHidden(view, false); }, reset: () => { clear();input.value = '';resultTable.replaceChildren();setHidden(unavailable, true);setHidden(success, true);setHidden(view, true); } };
}

const COUNT_KEYS = ['rawEvents', 'eventIngressReceipts', 'eventProcessingAdmissions', 'chatMessages', 'eventProcessingFailures', 'agentTurns', 'contextTraces', 'actionDecisions', 'actionExecutions', 'memoryRecords', 'memorySources', 'memoryRevisions', 'toolCalls', 'auditLog', 'jobs', 'jobAttempts', 'workerHeartbeats'];
function operationsStatus(value) {
if (!exact(value, ['generatedAt', 'overall', 'database', 'schema', 'counts', 'configuration', 'workflows']) || !date(value.generatedAt) || !['ok', 'attention_required'].includes(value.overall)
|| !exact(value.database, ['open', 'readonly', 'integrity', 'foreignKeys']) || typeof value.database.open !== 'boolean' || typeof value.database.readonly !== 'boolean' || !['ok', 'attention_required'].includes(value.database.integrity) || !['clean', 'violations_present'].includes(value.database.foreignKeys)
|| !exact(value.schema, ['ready', 'requiredTablesPresent', 'requiredTablesTotal', 'missingTableCount']) || typeof value.schema.ready !== 'boolean' || ![value.schema.requiredTablesPresent, value.schema.requiredTablesTotal, value.schema.missingTableCount].every(integer)
|| !exact(value.counts, COUNT_KEYS) || !COUNT_KEYS.every((key) => integer(value.counts[key]))
|| !exact(value.configuration, ['oneBot', 'server', 'retentionDays'])
|| !exact(value.configuration.oneBot, ['transport', 'httpConfigured', 'wsConfigured', 'tokenConfigured', 'botIdConfigured'])
|| !['http', 'ws'].includes(value.configuration.oneBot.transport)
|| !['httpConfigured', 'wsConfigured', 'tokenConfigured', 'botIdConfigured'].every((key) => typeof value.configuration.oneBot[key] === 'boolean')
|| !exact(value.configuration.server, ['hostConfigured', 'portConfigured', 'healthPathConfigured', 'readinessPathConfigured', 'metricsPathConfigured', 'eventPathConfigured'])
|| !Object.values(value.configuration.server).every((entry) => typeof entry === 'boolean')
|| !exact(value.configuration.retentionDays, ['rawEvents', 'chatMessages', 'auditLog', 'disabledDeletedMemory', 'eventProcessingFailures']) || !Object.values(value.configuration.retentionDays).every(integer)
|| !exact(value.workflows, ['backup', 'restore']) || !exact(value.workflows.backup, ['available']) || value.workflows.backup.available !== true || !exact(value.workflows.restore, ['available', 'executionBoundary']) || value.workflows.restore.available !== true || value.workflows.restore.executionBoundary !== 'stopped_service_only') return null;
return value;
}
function backupPreview(value, now) {
return exact(value, ['action', 'currentState', 'contractVersion', 'effects', 'restore', 'rollback', 'previewDigest', 'previewHandle', 'previewExpiresAt'])
&& value.action === 'create_verified_backup' && value.currentState === 'available' && value.contractVersion === 1
&& exact(value.effects, ['databaseMutation', 'privateArtifactCreation', 'integrityVerification', 'destinationOverwrite'])
&& value.effects.databaseMutation === false && value.effects.privateArtifactCreation === true && value.effects.integrityVerification === true && value.effects.destinationOverwrite === false
&& exact(value.restore, ['availableAfterCompletion', 'executionBoundary']) && value.restore.availableAfterCompletion === true && value.restore.executionBoundary === 'stopped_service_only'
&& exact(value.rollback, ['available', 'reason']) && value.rollback.available === false && value.rollback.reason === 'artifact_removal_not_exposed'
&& DIGEST.test(value.previewDigest) && OPAQUE.test(value.previewHandle) && integer(value.previewExpiresAt) && value.previewExpiresAt > now ? value : null;
}
function backupResult(value) {
return exact(value, ['status', 'artifact', 'pages', 'restore', 'backupRef'])
&& ['completed', 'attention_required'].includes(value.status)
&& exact(value.artifact, ['integrity', 'sizeBytes']) && ['verified', 'attention_required'].includes(value.artifact.integrity) && integer(value.artifact.sizeBytes)
&& exact(value.pages, ['total', 'remaining', 'complete']) && integer(value.pages.total) && integer(value.pages.remaining) && value.pages.remaining <= value.pages.total && typeof value.pages.complete === 'boolean' && value.pages.complete === (value.pages.remaining === 0)
&& exact(value.restore, ['available', 'executionBoundary']) && typeof value.restore.available === 'boolean' && value.restore.executionBoundary === 'stopped_service_only'
&& (value.backupRef === null || OPAQUE.test(value.backupRef))
&& ((value.status === 'completed' && value.artifact.integrity === 'verified' && value.pages.complete && value.restore.available && OPAQUE.test(value.backupRef)) || (value.status === 'attention_required' && value.backupRef === null)) ? value : null;
}
function restorePreview(value, now) {
return exact(value, ['action', 'currentState', 'contractVersion', 'artifact', 'effects', 'restore', 'rollback', 'previewDigest', 'previewHandle', 'previewExpiresAt'])
&& value.action === 'prepare_restore_handoff' && value.currentState === 'verified_backup_available' && value.contractVersion === 1
&& exact(value.artifact, ['integrity', 'sizeBytes']) && value.artifact.integrity === 'verified' && integer(value.artifact.sizeBytes)
&& exact(value.effects, ['databaseMutation', 'artifactMutation', 'restoreExecution', 'serviceStopRequired']) && value.effects.databaseMutation === false && value.effects.artifactMutation === false && value.effects.restoreExecution === false && value.effects.serviceStopRequired === true
&& exact(value.restore, ['available', 'executionBoundary']) && value.restore.available === true && value.restore.executionBoundary === 'stopped_service_only'
&& exact(value.rollback, ['available', 'reason']) && value.rollback.available === false && value.rollback.reason === 'no_in_process_effect'
&& DIGEST.test(value.previewDigest) && OPAQUE.test(value.previewHandle) && integer(value.previewExpiresAt) && value.previewExpiresAt > now ? value : null;
}
function handoff(value) {
return exact(value, ['status', 'handoffId', 'expiresAt', 'executionBoundary', 'effects'])
&& ['pending', 'attention_required'].includes(value.status)
&& ((value.status === 'pending' && OPAQUE.test(value.handoffId) && date(value.expiresAt)) || (value.status === 'attention_required' && value.handoffId === null && value.expiresAt === null))
&& value.executionBoundary === 'stopped_service_only' && exact(value.effects, ['restoreExecution']) && value.effects.restoreExecution === false ? value : null;
}

export function createOperationsFeature(elements, setHidden, requestJson, mutate, expired, announce) {
const nav = createElement('button', { id: 'operations-nav', class: 'nav-item', type: 'button', 'aria-controls': 'operations-view' }, 'Operations');elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', { id: 'operations-view', class: 'memory-view', 'aria-labelledby': 'operations-title', hidden: '' });elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });const heading = append(toolbar, 'div');append(heading, 'p', { class: 'eyebrow' }, 'Verified backup and stopped-service restore');append(heading, 'h1', { id: 'operations-title' }, 'Operations');const refresh = append(toolbar, 'button', { class: 'button button-secondary', type: 'button' }, 'Refresh');
const unavailable = state(view, 'operations-unavailable', 'error-band', 'alert', 'Operations unavailable', 'Refresh before continuing.');const current = append(view, 'section', { class: 'worker-heartbeats-content', hidden: '' });const currentTable = detailTable(current, 'Operations status', ['Overall', 'Database', 'Schema', 'Retention']);
const controls = append(view, 'section', { class: 'memory-scope-band', 'aria-labelledby': 'operations-actions-title' });append(controls, 'h2', { id: 'operations-actions-title' }, 'Governed actions');const backupButton = append(controls, 'button', { id: 'operations-backup-preview-button', class: 'button button-primary', type: 'button' }, 'Preview verified backup');const restoreButton = append(controls, 'button', { id: 'operations-restore-preview-button', class: 'button button-secondary', type: 'button', disabled: '' }, 'Preview restore handoff');
const previewSurface = append(view, 'section', { id: 'operations-preview', class: 'worker-heartbeats-content', hidden: '' });const previewTable = detailTable(previewSurface, 'Operations preview', ['Action', 'Effects', 'Restore', 'Boundary']);const confirmButton = append(previewSurface, 'button', { id: 'operations-confirm-button', class: 'button button-primary', type: 'button', disabled: '' }, 'Confirm operation');
const success = state(view, 'operations-success', 'worker-heartbeats-content', 'status', 'Operation completed', 'Bounded local operations evidence is available.');const resultTable = detailTable(success, 'Operations result', ['Status', 'Artifact', 'Restore', 'Boundary']);
const retentionPanel = createRetentionPanel(view, setHidden, mutate, expired, announce, clear);
  let backupRef = null;let authority = null;let readSequence = 0;let previewSequence = 0;let confirmSequence = 0;let timer = null;
function updateActions() { backupButton.disabled = false;restoreButton.disabled = backupRef === null; }
function clear() { previewSequence += 1;confirmSequence += 1;if (timer !== null) window.clearTimeout(timer);timer = null;authority = null;confirmButton.disabled = true;previewTable.replaceChildren();setHidden(previewSurface, true);updateActions(); }
async function load() { const sequence = ++readSequence;clear();retentionPanel.clear();refresh.disabled = true;const response = await requestJson(OPERATIONS_ENDPOINT);if (sequence !== readSequence) return;refresh.disabled = false;if (response.status === 401) return expired();const normalized = response.status === 200 ? operationsStatus(response.body) : null;if (!normalized) { setHidden(unavailable, false);announce('Operations unavailable.');return; }rows(currentTable, [['Overall', normalized.overall, normalized.generatedAt], ['Database', normalized.database.integrity, normalized.database.foreignKeys], ['Schema', normalized.schema.ready ? 'ready' : 'attention required', String(normalized.schema.missingTableCount) + ' missing'], ['Retention', String(normalized.configuration.retentionDays.rawEvents) + ' raw-event days', 'Policy evidence only']]);setHidden(unavailable, true);setHidden(current, false);announce('Operations updated.'); }
async function preview(kind) { clear();retentionPanel.clear();backupButton.disabled = true;restoreButton.disabled = true;const sequence = ++previewSequence;const endpoint = kind === 'backup' ? OPERATIONS_ENDPOINT : RESTORE_ENDPOINT;const body = kind === 'backup' ? { action: 'create_verified_backup' } : { action: 'prepare_restore_handoff', backupRef };const response = await mutate(endpoint, body);if (sequence !== previewSequence) return;updateActions();if (response.status === 401) return expired();const normalized = response.status === 201 ? (kind === 'backup' ? backupPreview(response.body, Date.now()) : restorePreview(response.body, Date.now())) : null;if (!normalized) { announce('Operations preview unavailable.');return; }if (kind === 'backup') rows(previewTable, [['Action', normalized.action, normalized.currentState], ['Effects', 'Private artifact creation', 'No database mutation'], ['Restore', normalized.restore.executionBoundary, 'Available after completion'], ['Boundary', normalized.rollback.reason, 'No artifact removal']]);else rows(previewTable, [['Action', normalized.action, normalized.currentState], ['Effects', 'No restore execution', 'Service stop required'], ['Restore', normalized.restore.executionBoundary, String(normalized.artifact.sizeBytes) + ' bytes'], ['Boundary', normalized.rollback.reason, 'Handoff only']]);authority = { kind, handle: normalized.previewHandle, expiresAt: normalized.previewExpiresAt, backupRef };backupButton.disabled = true;restoreButton.disabled = true;setHidden(previewSurface, false);confirmButton.disabled = false;timer = window.setTimeout(() => { authority = null;confirmButton.disabled = true;updateActions();setHidden(previewSurface, true);announce('Operations preview expired.'); }, Math.min(normalized.previewExpiresAt - Date.now(), 2_147_483_647));announce('Operations preview ready.'); }
async function confirm() { const retained = authority;if (!retained || confirmButton.disabled || retained.expiresAt <= Date.now() || (retained.kind === 'restore' && retained.backupRef !== backupRef)) { clear();return; }authority = null;confirmButton.disabled = true;if (timer !== null) window.clearTimeout(timer);timer = null;const sequence = ++confirmSequence;const endpoint = retained.kind === 'backup' ? OPERATIONS_ENDPOINT + '/confirm' : RESTORE_ENDPOINT + '/confirm';const body = retained.kind === 'backup' ? { confirm: true, previewHandle: retained.handle } : { confirm: true, previewHandle: retained.handle, backupRef: retained.backupRef };const response = await mutate(endpoint, body);if (sequence !== confirmSequence) return;updateActions();if (response.status === 401) return expired();if (retained.kind === 'backup') { const normalized = response.status === 200 ? backupResult(response.body) : null;if (!normalized) { announce('Verified backup unavailable.');return; }backupRef = normalized.backupRef;restoreButton.disabled = backupRef === null;rows(resultTable, [['Status', normalized.status, normalized.artifact.integrity], ['Artifact', String(normalized.artifact.sizeBytes) + ' bytes', normalized.pages.complete ? 'Complete' : 'Incomplete'], ['Restore', normalized.restore.executionBoundary, normalized.restore.available ? 'Handoff available' : 'Unavailable'], ['Boundary', 'Private server-owned artifact', 'Reference retained in memory only']]);announce(normalized.status === 'completed' ? 'Verified backup completed.' : 'Verified backup needs attention.'); } else { const normalized = response.status === 200 ? handoff(response.body) : null;if (!normalized) { announce('Restore handoff unavailable.');return; }backupRef = null;restoreButton.disabled = true;rows(resultTable, [['Status', normalized.status, normalized.expiresAt || 'No handoff created'], ['Artifact', 'Verified backup retained', 'No artifact mutation'], ['Restore', normalized.executionBoundary, 'No in-process restore'], ['Boundary', 'Stop the service before execution', normalized.effects.restoreExecution ? 'Unexpected execution' : 'Handoff only']]);announce(normalized.status === 'pending' ? 'Restore handoff prepared.' : 'Restore handoff needs attention.'); }setHidden(previewSurface, true);setHidden(success, false); }
refresh.addEventListener('click', () => void load());backupButton.addEventListener('click', () => void preview('backup'));restoreButton.addEventListener('click', () => void preview('restore'));confirmButton.addEventListener('click', () => void confirm());setHidden(unavailable, true);setHidden(current, true);setHidden(success, true);
return { nav, view, load, reset: () => { readSequence += 1;clear();retentionPanel.reset();backupRef = null;restoreButton.disabled = true;currentTable.replaceChildren();resultTable.replaceChildren();setHidden(current, true);setHidden(unavailable, true);setHidden(success, true);setHidden(view, true); } };
}
