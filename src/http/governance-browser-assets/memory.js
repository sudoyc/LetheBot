import { createMemoryApplicationWorkflow } from '/governance/memory-application.js';
import {
createMemoryRecordMutationWorkflow,
MEMORY_RECORD_FORGET_WORKFLOW,
MEMORY_RECORD_RESTORE_WORKFLOW,
} from '/governance/memory-record-mutations.js';
import {
createMemoryMaintenanceTransitionWorkflow,
MEMORY_EXPIRATION_WORKFLOW,
MEMORY_ROLLBACK_WORKFLOW,
} from '/governance/memory-maintenance-transitions.js';
import {
append,
createElement,
createMemoryApplicationPreview,
detailTable,
normalizeMemoryRecordPage,
normalizeMemoryReviewPage,
normalizeMemoryReviewScopeCatalog,
normalizeMemoryScopeCatalog,
renderMemoryApprovalConfirmation,
renderMemoryApprovalPreview,
renderMemoryRejectionConfirmation,
renderMemoryRejectionPreview,
renderMemoryRecordDetail,
renderMemoryRecords,
renderMemoryReviewDetail,
renderMemoryReviews,
} from '/governance/memory-presentation.js';
const MEMORY_SCOPES_ENDPOINT = '/governance/api/v1/memory/scopes';
const MEMORY_RECORDS_ENDPOINT = '/governance/api/v1/memory/records';
const MEMORY_RECORD_DETAIL_ENDPOINT = MEMORY_RECORDS_ENDPOINT + '/';
const MEMORY_REVIEW_SCOPES_ENDPOINT = '/governance/api/v1/scopes';
const MEMORY_REVIEWS_ENDPOINT = '/governance/api/v1/memory-reviews';
const MEMORY_REVIEW_DETAIL_ENDPOINT = MEMORY_REVIEWS_ENDPOINT + '/';
const MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT = MEMORY_REVIEWS_ENDPOINT + '/';
const MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX = '/confirm';

function createState(parent, id, className, role, title, description) {
const state = append(parent, 'section', { id, class: className, role, hidden: '' });
append(state, 'h2', {}, title);
append(state, 'p', {}, description);
return state;
}

export function createMemoryFeature(
elements,
setHidden,
setText,
requestJson,
requestMemoryMutation,
showSessionExpired,
announce,
) {
const nav = createElement('button', {
id: 'memory-nav',
class: 'nav-item',
type: 'button',
'aria-controls': 'memory-view',
}, 'Memory');
elements.navigation?.insertBefore(nav, elements.activityNav);
const view = createElement('section', {
id: 'memory-view',
class: 'memory-view',
'aria-labelledby': 'memory-title',
hidden: '',
});
elements.main?.insertBefore(view, elements.activityView);
const toolbar = append(view, 'header', { class: 'view-toolbar' });
const title = append(toolbar, 'div');
append(title, 'p', { class: 'eyebrow' }, 'Governed records');
append(title, 'h1', { id: 'memory-title' }, 'Memory');
const refreshButton = append(toolbar, 'button', {
id: 'memory-refresh-button',
class: 'button button-secondary',
type: 'button',
}, 'Refresh');
const tabs = append(view, 'div', {
class: 'memory-tabs',
role: 'tablist',
'aria-label': 'Memory views',
});
const recordsTab = append(tabs, 'button', {
id: 'memory-records-tab',
class: 'activity-tab',
type: 'button',
role: 'tab',
'aria-selected': 'true',
'aria-controls': 'memory-records-panel',
}, 'Records');
const reviewsTab = append(tabs, 'button', {
id: 'memory-reviews-tab',
class: 'activity-tab',
type: 'button',
role: 'tab',
'aria-selected': 'false',
'aria-controls': 'memory-reviews-panel',
tabindex: '-1',
}, 'Review');
const recordsPanel = append(view, 'section', {
id: 'memory-records-panel',
class: 'memory-panel',
role: 'tabpanel',
'aria-labelledby': 'memory-records-tab',
});
const scopeBand = append(recordsPanel, 'section', {
class: 'memory-scope-band',
'aria-labelledby': 'memory-scope-title',
});
const scopeTitle = append(scopeBand, 'div');
append(scopeTitle, 'p', { class: 'eyebrow' }, 'Current scope');
append(scopeTitle, 'h2', { id: 'memory-scope-title' }, 'Records');
const scopeControl = append(scopeBand, 'div');
append(scopeControl, 'label', { for: 'memory-scope-select' }, 'Memory scope');
const scopeSelect = append(scopeControl, 'select', {
id: 'memory-scope-select',
disabled: '',
'aria-describedby': 'memory-scope-note',
});
append(scopeSelect, 'option', { value: '' }, 'Select a scope');
const scopeNote = append(scopeControl, 'p', {
id: 'memory-scope-note',
class: 'memory-scope-note',
}, 'Choose one exact scope.');
const scopeLoading = createState(
recordsPanel,
'memory-scope-loading',
'empty-band',
'status',
'Loading memory scopes',
'Available exact scopes are being refreshed.',
);
const scopeError = createState(
recordsPanel,
'memory-scope-error',
'error-band',
'alert',
'Memory scopes unavailable',
'Refresh the scope catalog.',
);
const scopeEmpty = createState(
recordsPanel,
'memory-scope-empty',
'empty-band',
'status',
'No memory scopes',
'Memory records will appear after a governed scope exists.',
);
const selection = createState(
recordsPanel,
'memory-selection',
'empty-band',
'status',
'Select a memory scope',
'Records stay closed until one exact scope is selected.',
);
const count = append(recordsPanel, 'p', {
id: 'memory-records-count',
class: 'memory-records-count',
hidden: '',
}, 'Showing -- records');
const recordsLoading = append(recordsPanel, 'div', {
id: 'memory-records-loading',
class: 'worker-heartbeats-skeleton memory-records-skeleton',
'aria-hidden': 'true',
hidden: '',
});
for (let row = 0; row < 4; row += 1) {
const skeletonRow = append(recordsLoading, 'div');
for (let column = 0; column < 5; column += 1) append(skeletonRow, 'span');
}
const recordsError = createState(
recordsPanel,
'memory-records-error',
'error-band',
'alert',
'Memory records unavailable',
'Refresh the selected scope.',
);
const recordsEmpty = createState(
recordsPanel,
'memory-records-empty',
'empty-band',
'status',
'No memory records',
'This exact scope has no governed records.',
);
const content = append(recordsPanel, 'div', {
id: 'memory-records-content',
class: 'worker-heartbeats-content memory-records-content',
'aria-busy': 'false',
hidden: '',
});
const table = append(content, 'table', {
id: 'memory-records-table',
class: 'worker-heartbeats-table memory-records-table',
role: 'table',
});
append(table, 'caption', { class: 'sr-only' }, 'Memory records in the selected scope');
const colgroup = append(table, 'colgroup');
for (const className of [
'memory-column',
'lifecycle-column',
'governance-column',
'evidence-column',
'dates-column',
]) append(colgroup, 'col', { class: className });
const headingRow = append(append(table, 'thead'), 'tr');
for (const heading of ['Memory', 'Lifecycle', 'Governance', 'Evidence', 'Dates']) {
append(headingRow, 'th', { scope: 'col' }, heading);
}
const list = append(table, 'tbody', { id: 'memory-records-list' });
const recordDetail = append(recordsPanel, 'section', {
id: 'memory-record-detail',
'aria-labelledby': 'memory-record-detail-title',
});
const recordDetailHeader = append(recordDetail, 'header', {
class: 'view-toolbar activity-panel-toolbar',
});
const recordDetailTitle = append(recordDetailHeader, 'div');
append(recordDetailTitle, 'p', { class: 'eyebrow' }, 'Selected record');
append(recordDetailTitle, 'h2', { id: 'memory-record-detail-title' }, 'Record provenance');
const recordDetailUnselected = createState(
recordDetail,
'memory-record-detail-unselected',
'empty-band',
'status',
'Select a record',
'Source, revision, and audit evidence will appear here.',
);
const recordDetailLoading = createState(
recordDetail,
'memory-record-detail-loading',
'empty-band',
'status',
'Loading record provenance',
'Source, revision, and audit evidence is being refreshed.',
);
const recordDetailMalformed = createState(
recordDetail,
'memory-record-detail-malformed',
'error-band',
'alert',
'Record provenance malformed',
'Refresh the selected record.',
);
const recordDetailError = createState(
recordDetail,
'memory-record-detail-error',
'error-band',
'alert',
'Record provenance unavailable',
'Refresh the Records list.',
);
const recordDetailNotFound = createState(
recordDetail,
'memory-record-detail-not-found',
'error-band',
'alert',
'Record provenance not found',
'Refresh the Records list for current access.',
);
const recordDetailStale = createState(
recordDetail,
'memory-record-detail-stale',
'error-band',
'alert',
'Record provenance changed',
'Refresh the Records list before continuing.',
);
const recordDetailContent = append(recordDetail, 'div', {
id: 'memory-record-detail-content',
class: 'worker-heartbeats-content',
'aria-busy': 'false',
hidden: '',
});
const recordDetailRecord = detailTable(
recordDetailContent,
'Selected memory record',
['Memory', 'Lifecycle', 'Governance', 'Evidence', 'Dates'],
);
append(recordDetailContent, 'h3', {}, 'Sources');
const recordDetailSourceCount = append(recordDetailContent, 'p', {
class: 'memory-records-count',
}, 'Showing -- sources');
const recordDetailSources = detailTable(
recordDetailContent,
'Memory record sources',
['Source', 'Resolution', 'Extractor', 'Timestamp'],
{ id: 'memory-record-detail-sources' },
);
append(recordDetailContent, 'h3', {}, 'Revisions');
const recordDetailRevisionCount = append(recordDetailContent, 'p', {
class: 'memory-records-count',
}, 'Showing -- revisions');
const recordDetailRevisions = detailTable(
recordDetailContent,
'Memory record revisions',
['Revision', 'Change', 'Lifecycle', 'Evidence'],
{ id: 'memory-record-detail-revisions' },
);
append(recordDetailContent, 'h3', {}, 'Audit');
const recordDetailAuditCount = append(recordDetailContent, 'p', {
class: 'memory-records-count',
}, 'Showing -- audit entries');
const recordDetailAudit = detailTable(
recordDetailContent,
'Memory record audit evidence',
['Event', 'Summary', 'Risk', 'Evidence'],
{ id: 'memory-record-detail-audit' },
);
const reviewsPanel = append(view, 'section', {
id: 'memory-reviews-panel',
class: 'memory-panel',
role: 'tabpanel',
'aria-labelledby': 'memory-reviews-tab',
hidden: '',
});
const reviewScopeBand = append(reviewsPanel, 'section', {
class: 'memory-scope-band',
'aria-labelledby': 'memory-review-scope-title',
});
const reviewScopeTitle = append(reviewScopeBand, 'div');
append(reviewScopeTitle, 'p', { class: 'eyebrow' }, 'Current scope');
append(reviewScopeTitle, 'h2', { id: 'memory-review-scope-title' }, 'Review queue');
const reviewScopeControl = append(reviewScopeBand, 'div');
append(reviewScopeControl, 'label', {
for: 'memory-review-scope-select',
}, 'Review scope');
const reviewScopeSelect = append(reviewScopeControl, 'select', {
id: 'memory-review-scope-select',
disabled: '',
'aria-describedby': 'memory-review-scope-note',
});
append(reviewScopeSelect, 'option', { value: '' }, 'Select a scope');
const reviewScopeNote = append(reviewScopeControl, 'p', {
id: 'memory-review-scope-note',
class: 'memory-scope-note',
}, 'Choose one exact scope.');
const reviewScopeLoading = createState(
reviewsPanel,
'memory-review-scope-loading',
'empty-band',
'status',
'Loading review scopes',
'Available exact scopes are being refreshed.',
);
const reviewScopeError = createState(
reviewsPanel,
'memory-review-scope-error',
'error-band',
'alert',
'Review scopes unavailable',
'Refresh the scope catalog.',
);
const reviewScopeEmpty = createState(
reviewsPanel,
'memory-review-scope-empty',
'empty-band',
'status',
'No review scopes',
'Review proposals will appear after a governed scope exists.',
);
const reviewSelection = createState(
reviewsPanel,
'memory-review-selection',
'empty-band',
'status',
'Select a review scope',
'Reviews stay closed until one exact scope is selected.',
);
const reviewsCount = append(reviewsPanel, 'p', {
id: 'memory-reviews-count',
class: 'memory-records-count',
hidden: '',
}, 'Showing -- reviews');
const reviewsLoading = append(reviewsPanel, 'div', {
id: 'memory-reviews-loading',
class: 'worker-heartbeats-skeleton memory-records-skeleton memory-reviews-skeleton',
'aria-hidden': 'true',
hidden: '',
});
for (let row = 0; row < 4; row += 1) {
const skeletonRow = append(reviewsLoading, 'div');
for (let column = 0; column < 5; column += 1) append(skeletonRow, 'span');
}
const reviewsError = createState(
reviewsPanel,
'memory-reviews-error',
'error-band',
'alert',
'Memory reviews unavailable',
'Refresh the selected scope.',
);
const reviewsEmpty = createState(
reviewsPanel,
'memory-reviews-empty',
'empty-band',
'status',
'No memory reviews',
'This exact scope has no maintenance proposals.',
);
const reviewsContent = append(reviewsPanel, 'div', {
id: 'memory-reviews-content',
class: 'worker-heartbeats-content memory-records-content memory-reviews-content',
'aria-busy': 'false',
hidden: '',
});
const reviewsTable = append(reviewsContent, 'table', {
id: 'memory-reviews-table',
class: 'worker-heartbeats-table memory-reviews-table',
role: 'table',
});
append(reviewsTable, 'caption', { class: 'sr-only' },
'Memory maintenance proposals in the selected scope');
const reviewColgroup = append(reviewsTable, 'colgroup');
for (const className of [
'proposal-column',
'review-lifecycle-column',
'candidates-column',
'confidence-column',
'review-dates-column',
]) append(reviewColgroup, 'col', { class: className });
const reviewHeadingRow = append(append(reviewsTable, 'thead'), 'tr');
for (const heading of ['Proposal', 'Lifecycle', 'Candidates', 'Confidence', 'Dates']) {
append(reviewHeadingRow, 'th', { scope: 'col' }, heading);
}
const reviewsList = append(reviewsTable, 'tbody', { id: 'memory-reviews-list' });
const reviewDetail = append(reviewsPanel, 'section', {
id: 'memory-review-detail',
'aria-labelledby': 'memory-review-detail-title',
});
const reviewDetailHeader = append(reviewDetail, 'header', {
class: 'view-toolbar activity-panel-toolbar',
});
const reviewDetailTitle = append(reviewDetailHeader, 'div');
append(reviewDetailTitle, 'p', { class: 'eyebrow' }, 'Selected proposal');
append(reviewDetailTitle, 'h2', { id: 'memory-review-detail-title' }, 'Review detail');
const reviewDetailUnselected = createState(
reviewDetail,
'memory-review-detail-unselected',
'empty-band',
'status',
'Select a review',
'Candidate and revision evidence will appear here.',
);
const reviewDetailLoading = createState(
reviewDetail,
'memory-review-detail-loading',
'empty-band',
'status',
'Loading review detail',
'Candidate and revision evidence is being refreshed.',
);
const reviewDetailMalformed = createState(
reviewDetail,
'memory-review-detail-malformed',
'error-band',
'alert',
'Review detail malformed',
'Refresh the selected review.',
);
const reviewDetailError = createState(
reviewDetail,
'memory-review-detail-error',
'error-band',
'alert',
'Review detail unavailable',
'Refresh the Review queue.',
);
const reviewDetailNotFound = createState(
reviewDetail,
'memory-review-detail-not-found',
'error-band',
'alert',
'Review detail not found',
'Refresh the Review queue for current access.',
);
const reviewDetailStale = createState(
reviewDetail,
'memory-review-detail-stale',
'error-band',
'alert',
'Review detail changed',
'Refresh the Review queue before continuing.',
);
const reviewDetailContent = append(reviewDetail, 'div', {
id: 'memory-review-detail-content',
class: 'worker-heartbeats-content',
'aria-busy': 'false',
hidden: '',
});
const reviewDetailSummary = detailTable(
reviewDetailContent,
'Selected memory maintenance proposal',
['Proposal', 'Lifecycle', 'Effect', 'Evidence', 'Dates'],
);
append(reviewDetailContent, 'h3', {}, 'Candidates');
const reviewDetailCandidateCount = append(reviewDetailContent, 'p', {
class: 'memory-records-count',
}, 'Showing -- candidates');
const reviewDetailCandidates = detailTable(
reviewDetailContent,
'Memory maintenance candidates',
['Candidate', 'Role', 'Record evidence', 'Source evidence'],
{ id: 'memory-review-detail-candidates' },
);
append(reviewDetailContent, 'h3', {}, 'Revisions');
const reviewDetailRevisionCount = append(reviewDetailContent, 'p', {
class: 'memory-records-count',
}, 'Showing -- revisions');
const reviewDetailRevisions = detailTable(
reviewDetailContent,
'Memory maintenance proposal revisions',
['Revision', 'Transition', 'Actor', 'Evidence'],
{ id: 'memory-review-detail-revisions' },
);
const {
button: applicationPreviewButton,
selection: applicationSelection,
retainedSelect: retainedMemorySelect,
evidence: applicationPreviewEvidence,
states: applicationPreviewStateElements,
} = createMemoryApplicationPreview(reviewDetailContent);
const approvalPreview = append(reviewDetailContent, 'section', {
id: 'memory-review-approval-preview',
'aria-labelledby': 'memory-review-approval-preview-title',
});
const approvalPreviewHeader = append(approvalPreview, 'header', {
class: 'view-toolbar activity-panel-toolbar',
});
const approvalPreviewTitle = append(approvalPreviewHeader, 'div');
append(approvalPreviewTitle, 'p', { class: 'eyebrow' }, 'Write-free operation');
append(approvalPreviewTitle, 'h3', {
id: 'memory-review-approval-preview-title',
}, 'Approval preview');
const approvalPreviewButton = append(approvalPreviewHeader, 'button', { id: 'memory-review-approval-preview-button', class: 'button button-primary', type: 'button', 'aria-controls': 'memory-review-approval-preview-populated', disabled: '' }, 'Preview approval');
const approvalPreviewUnrequested = createState(
approvalPreview,
'memory-review-approval-preview-unrequested',
'empty-band',
'status',
'Approval preview not requested',
'No current approval preview is loaded.',
);
const approvalPreviewLoading = createState(
approvalPreview,
'memory-review-approval-preview-loading',
'empty-band',
'status',
'Loading approval preview',
'Current approval effects are being prepared.',
);
const approvalPreviewMalformed = createState(
approvalPreview,
'memory-review-approval-preview-malformed',
'error-band',
'alert',
'Approval preview malformed',
'Refresh the Review queue before requesting another preview.',
);
const approvalPreviewUnavailable = createState(
approvalPreview,
'memory-review-approval-preview-unavailable',
'error-band',
'alert',
'Approval preview unavailable',
'Request the preview again.',
);
const approvalPreviewNotFound = createState(
approvalPreview,
'memory-review-approval-preview-not-found',
'error-band',
'alert',
'Approval preview not found',
'Refresh the Review queue for current access.',
);
const approvalPreviewStale = createState(
approvalPreview,
'memory-review-approval-preview-stale',
'error-band',
'alert',
'Approval preview changed',
'Refresh the Review queue before continuing.',
);
const approvalPreviewPopulated = append(approvalPreview, 'div', {
id: 'memory-review-approval-preview-populated',
class: 'worker-heartbeats-content',
hidden: '',
});
const approvalPreviewEvidence = detailTable(
approvalPreviewPopulated,
'Memory maintenance approval preview',
['Action', 'Effect', 'Transition', 'Rollback'],
{ id: 'memory-review-approval-preview-evidence' },
);
const approvalConfirmationControls = append(approvalPreviewPopulated, 'div', {
class: 'view-toolbar activity-panel-toolbar',
});
const approvalConfirmationButton = append(approvalConfirmationControls, 'button', {
id: 'memory-review-approval-confirm-button',
class: 'button button-primary',
type: 'button',
disabled: '',
}, 'Confirm approval');
const rejectionPreview = append(reviewDetailContent, 'section', {
id: 'memory-review-rejection-preview',
'aria-labelledby': 'memory-review-rejection-preview-title',
});
const rejectionPreviewHeader = append(rejectionPreview, 'header', {
class: 'view-toolbar activity-panel-toolbar',
});
const rejectionPreviewTitle = append(rejectionPreviewHeader, 'div');
append(rejectionPreviewTitle, 'p', { class: 'eyebrow' }, 'Write-free operation');
append(rejectionPreviewTitle, 'h3', {
id: 'memory-review-rejection-preview-title',
}, 'Rejection preview');
const rejectionPreviewButton = append(rejectionPreviewHeader, 'button', { id: 'memory-review-rejection-preview-button', class: 'button button-secondary', type: 'button', 'aria-controls': 'memory-review-rejection-preview-populated', disabled: '' }, 'Preview rejection');
const rejectionPreviewUnrequested = createState(
rejectionPreview,
'memory-review-rejection-preview-unrequested',
'empty-band',
'status',
'Rejection preview not requested',
'No current rejection preview is loaded.',
);
const rejectionPreviewLoading = createState(
rejectionPreview,
'memory-review-rejection-preview-loading',
'empty-band',
'status',
'Loading rejection preview',
'Current rejection effects are being prepared.',
);
const rejectionPreviewMalformed = createState(
rejectionPreview,
'memory-review-rejection-preview-malformed',
'error-band',
'alert',
'Rejection preview malformed',
'Refresh the Review queue before requesting another preview.',
);
const rejectionPreviewUnavailable = createState(
rejectionPreview,
'memory-review-rejection-preview-unavailable',
'error-band',
'alert',
'Rejection preview unavailable',
'Request the preview again.',
);
const rejectionPreviewNotFound = createState(
rejectionPreview,
'memory-review-rejection-preview-not-found',
'error-band',
'alert',
'Rejection preview not found',
'Refresh the Review queue for current access.',
);
const rejectionPreviewStale = createState(
rejectionPreview,
'memory-review-rejection-preview-stale',
'error-band',
'alert',
'Rejection preview changed',
'Refresh the Review queue before continuing.',
);
const rejectionPreviewPopulated = append(rejectionPreview, 'div', {
id: 'memory-review-rejection-preview-populated',
class: 'worker-heartbeats-content',
hidden: '',
});
const rejectionPreviewEvidence = detailTable(
rejectionPreviewPopulated,
'Memory maintenance rejection preview',
['Action', 'Effect', 'Transition', 'Rollback'],
{ id: 'memory-review-rejection-preview-evidence' },
);
const rejectionConfirmationControls = append(rejectionPreviewPopulated, 'div', {
class: 'view-toolbar activity-panel-toolbar',
});
const rejectionConfirmationButton = append(rejectionConfirmationControls, 'button', {
id: 'memory-review-rejection-confirm-button',
class: 'button button-primary',
type: 'button',
disabled: '',
}, 'Confirm rejection');
const approvalConfirmationConfirming = createState(
reviewDetail,
'memory-review-approval-confirming',
'empty-band',
'status',
'Confirming approval',
'The current approval preview is being submitted.',
);
const approvalConfirmationMalformed = createState(
reviewDetail,
'memory-review-approval-confirm-malformed',
'error-band',
'alert',
'Approval result malformed',
'Request a fresh approval preview before trying again.',
);
const approvalConfirmationUnavailable = createState(
reviewDetail,
'memory-review-approval-confirm-unavailable',
'error-band',
'alert',
'Approval confirmation unavailable',
'Request a fresh approval preview before trying again.',
);
const approvalConfirmationNotFound = createState(
reviewDetail,
'memory-review-approval-confirm-not-found',
'error-band',
'alert',
'Approval confirmation not found',
'Refresh the Review queue and request a fresh preview.',
);
const approvalConfirmationConflict = createState(
reviewDetail,
'memory-review-approval-confirm-conflict',
'error-band',
'alert',
'Approval confirmation changed',
'Refresh the Review queue and request a fresh preview.',
);
const approvalConfirmationSucceeded = append(reviewDetail, 'div', {
id: 'memory-review-approval-succeeded',
class: 'worker-heartbeats-content',
hidden: '',
});
const approvalConfirmationEvidence = detailTable(
approvalConfirmationSucceeded,
'Memory maintenance approval result',
['Outcome', 'Transition evidence', 'Memory effect', 'Rollback'],
{ id: 'memory-review-approval-result-evidence' },
);
const rejectionConfirmationConfirming = createState(
reviewDetail,
'memory-review-rejection-confirming',
'empty-band',
'status',
'Confirming rejection',
'The current rejection preview is being submitted.',
);
const rejectionConfirmationMalformed = createState(
reviewDetail,
'memory-review-rejection-confirm-malformed',
'error-band',
'alert',
'Rejection result malformed',
'Request a fresh rejection preview before trying again.',
);
const rejectionConfirmationUnavailable = createState(
reviewDetail,
'memory-review-rejection-confirm-unavailable',
'error-band',
'alert',
'Rejection confirmation unavailable',
'Request a fresh rejection preview before trying again.',
);
const rejectionConfirmationNotFound = createState(
reviewDetail,
'memory-review-rejection-confirm-not-found',
'error-band',
'alert',
'Rejection confirmation not found',
'Refresh the Review queue and request a fresh preview.',
);
const rejectionConfirmationConflict = createState(
reviewDetail,
'memory-review-rejection-confirm-conflict',
'error-band',
'alert',
'Rejection confirmation changed',
'Refresh the Review queue and request a fresh preview.',
);
const rejectionConfirmationSucceeded = append(reviewDetail, 'div', {
id: 'memory-review-rejection-succeeded',
class: 'worker-heartbeats-content',
hidden: '',
});
const rejectionConfirmationEvidence = detailTable(
rejectionConfirmationSucceeded,
'Memory maintenance rejection result',
['Outcome', 'Transition evidence', 'Memory effect', 'Rollback'],
{ id: 'memory-review-rejection-result-evidence' },
);
const stateElements = [
scopeLoading,
scopeError,
scopeEmpty,
selection,
recordsLoading,
recordsError,
recordsEmpty,
content,
];
const recordDetailStateElements = [
recordDetailUnselected,
recordDetailLoading,
recordDetailMalformed,
recordDetailError,
recordDetailNotFound,
recordDetailStale,
recordDetailContent,
];
const reviewStateElements = [
reviewScopeLoading,
reviewScopeError,
reviewScopeEmpty,
reviewSelection,
reviewsLoading,
reviewsError,
reviewsEmpty,
reviewsContent,
];
const reviewDetailStateElements = [
reviewDetailUnselected,
reviewDetailLoading,
reviewDetailMalformed,
reviewDetailError,
reviewDetailNotFound,
reviewDetailStale,
reviewDetailContent,
];
const approvalPreviewStateElements = [
approvalPreviewUnrequested,
approvalPreviewLoading,
approvalPreviewMalformed,
approvalPreviewUnavailable,
approvalPreviewNotFound,
approvalPreviewStale,
approvalPreviewPopulated,
];
const rejectionPreviewStateElements = [
rejectionPreviewUnrequested,
rejectionPreviewLoading,
rejectionPreviewMalformed,
rejectionPreviewUnavailable,
rejectionPreviewNotFound,
rejectionPreviewStale,
rejectionPreviewPopulated,
];
const approvalConfirmationStateElements = [
approvalConfirmationConfirming,
approvalConfirmationSucceeded,
approvalConfirmationMalformed,
approvalConfirmationUnavailable,
approvalConfirmationNotFound,
approvalConfirmationConflict,
];
const rejectionConfirmationStateElements = [
rejectionConfirmationConfirming,
rejectionConfirmationSucceeded,
rejectionConfirmationMalformed,
rejectionConfirmationUnavailable,
rejectionConfirmationNotFound,
rejectionConfirmationConflict,
];
let catalog = [];
let selectedFingerprint = null;
let recordEntries = [];
let selectedRecordRef = null;
let memoryRecordDetailRequestSequence = 0;
let selectedRecordDetail = null;
let forgetWorkflow;
let restoreWorkflow;
let reviewCatalog = [];
let selectedReviewFingerprint = null;
let reviewEntries = [];
let selectedReviewRef = null;
let memoryReviewDetailRequestSequence = 0;
let memoryApprovalPreviewRequestSequence = 0;
let memoryApprovalPreviewExpiryTimer = null;
let memoryRejectionPreviewRequestSequence = 0;
let memoryRejectionPreviewExpiryTimer = null;
let memoryApprovalConfirmationRequestSequence = 0;
let approvalConfirmationAuthority = null;
let approvalConfirmationInFlight = false;
let memoryRejectionConfirmationRequestSequence = 0;
let rejectionConfirmationAuthority = null;
let rejectionConfirmationInFlight = false;
let applicationWorkflow;
let rollbackWorkflow;
let expirationWorkflow;
let approvalPreviewState = 'unrequested';
let rejectionPreviewState = 'unrequested';
let approvalRefreshRequested = false;
let rejectionRefreshRequested = false;
let selectedReviewDetail = null;
let subview = 'records';

function hideStates() {
for (const element of stateElements) setHidden(element, true);
}

function hideRecordDetailStates() {
for (const element of recordDetailStateElements) setHidden(element, true);
}

function clearRecordDetailContent(preserveResult = false) {
forgetWorkflow?.clear(preserveResult);
restoreWorkflow?.clear(preserveResult);
selectedRecordDetail = null;
recordDetailRecord.replaceChildren();
recordDetailSources.replaceChildren();
recordDetailRevisions.replaceChildren();
recordDetailAudit.replaceChildren();
recordDetailSourceCount.textContent = 'Showing -- sources';
recordDetailRevisionCount.textContent = 'Showing -- revisions';
recordDetailAuditCount.textContent = 'Showing -- audit entries';
recordDetailContent.setAttribute('aria-busy', 'false');
}

function clearRecordDetail(preserveReference = false, preserveResult = false) {
memoryRecordDetailRequestSequence += 1;
recordEntries = [];
if (!preserveReference) selectedRecordRef = null;
clearRecordDetailContent(preserveResult);
hideRecordDetailStates();
}

function updateRecordMutationControls() {
const forgetBusy = Boolean(forgetWorkflow?.busy());
const restoreBusy = Boolean(restoreWorkflow?.busy());
forgetWorkflow?.update(restoreBusy);
restoreWorkflow?.update(forgetBusy);
}

function showRecordDetailState(state) {
hideRecordDetailStates();
recordDetailContent.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
const states = {
unselected: recordDetailUnselected,
loading: recordDetailLoading,
malformed: recordDetailMalformed,
error: recordDetailError,
'not-found': recordDetailNotFound,
stale: recordDetailStale,
content: recordDetailContent,
};
setHidden(states[state], false);
return state;
}

function selectedRecord() {
const record = recordEntries.find((entry) => entry.recordRef === selectedRecordRef);
const scope = selectedScope();
return record && scope ? {
...record,
scopeHandle: scope.handle,
scopeFingerprint: scope.fingerprint,
scopeExpiresAt: scope.expiresAt,
} : null;
}
function setExpanded(p, b) { for (const c of p.children) c.setAttribute('aria-expanded', c === b ? 'true' : 'false'); }

function selectRecord(target) {
const button = target?.closest?.('[data-record-index]');
if (!button || !list.contains(button)) return null;
const index = Number(button.getAttribute('data-record-index'));
const record = Number.isInteger(index) ? recordEntries[index] : null;
const scope = selectedScope();
if (!record || !scope) return null;
if (record.recordRef !== selectedRecordRef) clearRecordDetailContent();
selectedRecordRef = record.recordRef;
setExpanded(list, button);
return {
...record,
scopeHandle: scope.handle,
scopeFingerprint: scope.fingerprint,
scopeExpiresAt: scope.expiresAt,
};
}

function hideReviewStates() {
for (const element of reviewStateElements) setHidden(element, true);
}

function hideReviewDetailStates() {
for (const element of reviewDetailStateElements) setHidden(element, true);
}

function hideApprovalPreviewStates() {
for (const element of approvalPreviewStateElements) setHidden(element, true);
}

function hideRejectionPreviewStates() {
for (const element of rejectionPreviewStateElements) setHidden(element, true);
}

function hideApprovalConfirmationStates() {
for (const element of approvalConfirmationStateElements) setHidden(element, true);
}

function hideRejectionConfirmationStates() {
for (const element of rejectionConfirmationStateElements) setHidden(element, true);
}

function updateApprovalControls() {
const previewLoading = approvalPreviewState === 'loading'
|| rejectionPreviewState === 'loading';
const confirmationInFlight = approvalConfirmationInFlight || rejectionConfirmationInFlight;
const decisionBusy = previewLoading || confirmationInFlight;
const applicationBusy = Boolean(applicationWorkflow?.busy());
const rollbackBusy = Boolean(rollbackWorkflow?.busy());
const expirationBusy = Boolean(expirationWorkflow?.busy());
applicationWorkflow?.update(decisionBusy || rollbackBusy || expirationBusy);
rollbackWorkflow?.update(decisionBusy || applicationBusy || expirationBusy);
expirationWorkflow?.update(decisionBusy || applicationBusy || rollbackBusy);
const anyBusy = decisionBusy || applicationBusy || rollbackBusy || expirationBusy;
const reviewDecisionReady = selectedReviewDetail?.lifecycleState === 'pending_review';
approvalPreviewButton.disabled = anyBusy
|| !reviewDecisionReady;
rejectionPreviewButton.disabled = anyBusy
|| !reviewDecisionReady;
approvalConfirmationButton.disabled = anyBusy
|| approvalConfirmationAuthority === null
|| approvalConfirmationAuthority.expiresAt <= Date.now();
rejectionConfirmationButton.disabled = anyBusy
|| rejectionConfirmationAuthority === null
|| rejectionConfirmationAuthority.expiresAt <= Date.now();
}

function clearApprovalConfirmationAuthority() {
memoryApprovalConfirmationRequestSequence += 1;
approvalConfirmationAuthority = null;
approvalConfirmationInFlight = false;
updateApprovalControls();
}

function clearApprovalConfirmation() {
clearApprovalConfirmationAuthority();
approvalRefreshRequested = false;
approvalConfirmationEvidence.replaceChildren();
hideApprovalConfirmationStates();
}

function clearRejectionConfirmationAuthority() {
memoryRejectionConfirmationRequestSequence += 1;
rejectionConfirmationAuthority = null;
rejectionConfirmationInFlight = false;
updateApprovalControls();
}

function clearRejectionConfirmation() {
clearRejectionConfirmationAuthority();
rejectionRefreshRequested = false;
rejectionConfirmationEvidence.replaceChildren();
hideRejectionConfirmationStates();
}

function showApprovalConfirmationState(state) {
hideApprovalConfirmationStates();
const states = {
confirming: approvalConfirmationConfirming,
succeeded: approvalConfirmationSucceeded,
malformed: approvalConfirmationMalformed,
unavailable: approvalConfirmationUnavailable,
'not-found': approvalConfirmationNotFound,
conflict: approvalConfirmationConflict,
};
setHidden(states[state], false);
updateApprovalControls();
return state;
}

function showRejectionConfirmationState(state) {
hideRejectionConfirmationStates();
const states = {
confirming: rejectionConfirmationConfirming,
succeeded: rejectionConfirmationSucceeded,
malformed: rejectionConfirmationMalformed,
unavailable: rejectionConfirmationUnavailable,
'not-found': rejectionConfirmationNotFound,
conflict: rejectionConfirmationConflict,
};
setHidden(states[state], false);
updateApprovalControls();
return state;
}

function confirmationResultVisible() {
return applicationWorkflow?.resultVisible()
|| rollbackWorkflow?.resultVisible()
|| expirationWorkflow?.resultVisible()
|| !approvalConfirmationSucceeded.hidden || !rejectionConfirmationSucceeded.hidden;
}

function clearApprovalPreview(preserveConfirmationResult = false, preserveDetail = false) {
memoryApprovalPreviewRequestSequence += 1;
if (memoryApprovalPreviewExpiryTimer !== null) {
window.clearTimeout(memoryApprovalPreviewExpiryTimer);
memoryApprovalPreviewExpiryTimer = null;
}
if (!preserveDetail) selectedReviewDetail = null;
approvalPreviewEvidence.replaceChildren();
hideApprovalPreviewStates();
approvalPreviewState = 'unrequested';
if (preserveConfirmationResult) clearApprovalConfirmationAuthority();
else clearApprovalConfirmation();
updateApprovalControls();
}

function clearRejectionPreview(preserveConfirmationResult = false) {
memoryRejectionPreviewRequestSequence += 1;
if (memoryRejectionPreviewExpiryTimer !== null) {
window.clearTimeout(memoryRejectionPreviewExpiryTimer);
memoryRejectionPreviewExpiryTimer = null;
}
rejectionPreviewEvidence.replaceChildren();
hideRejectionPreviewStates();
rejectionPreviewState = 'unrequested';
if (preserveConfirmationResult) clearRejectionConfirmationAuthority();
else clearRejectionConfirmation();
updateApprovalControls();
}

function showApprovalPreviewState(state) {
hideApprovalPreviewStates();
const states = {
unrequested: approvalPreviewUnrequested,
loading: approvalPreviewLoading,
malformed: approvalPreviewMalformed,
unavailable: approvalPreviewUnavailable,
'not-found': approvalPreviewNotFound,
stale: approvalPreviewStale,
populated: approvalPreviewPopulated,
};
setHidden(states[state], false);
approvalPreviewState = state;
updateApprovalControls();
return state;
}

function showRejectionPreviewState(state) {
hideRejectionPreviewStates();
const states = {
unrequested: rejectionPreviewUnrequested,
loading: rejectionPreviewLoading,
malformed: rejectionPreviewMalformed,
unavailable: rejectionPreviewUnavailable,
'not-found': rejectionPreviewNotFound,
stale: rejectionPreviewStale,
populated: rejectionPreviewPopulated,
};
setHidden(states[state], false);
rejectionPreviewState = state;
updateApprovalControls();
return state;
}

function scheduleApprovalPreviewExpiry(expiresAt, requestSequence) {
const expire = () => {
if (requestSequence !== memoryApprovalPreviewRequestSequence) return;
const delay = expiresAt - Date.now();
if (delay > 0) {
memoryApprovalPreviewExpiryTimer = window.setTimeout(expire, Math.min(delay, 2_147_483_647));
return;
}
memoryApprovalPreviewExpiryTimer = null;
memoryApprovalPreviewRequestSequence += 1;
clearApprovalConfirmation();
approvalPreviewEvidence.replaceChildren();
showApprovalPreviewState('stale');
announce('Approval preview expired.');
};
expire();
}

function scheduleRejectionPreviewExpiry(expiresAt, requestSequence) {
const expire = () => {
if (requestSequence !== memoryRejectionPreviewRequestSequence) return;
const delay = expiresAt - Date.now();
if (delay > 0) {
memoryRejectionPreviewExpiryTimer = window.setTimeout(expire, Math.min(delay, 2_147_483_647));
return;
}
memoryRejectionPreviewExpiryTimer = null;
memoryRejectionPreviewRequestSequence += 1;
clearRejectionConfirmation();
rejectionPreviewEvidence.replaceChildren();
showRejectionPreviewState('stale');
announce('Rejection preview expired.');
};
expire();
}

function clearReviewDetailContent(preserveConfirmationResult = false) {
applicationWorkflow?.clear(preserveConfirmationResult);
rollbackWorkflow?.clear(preserveConfirmationResult);
expirationWorkflow?.clear(preserveConfirmationResult);
retainedMemorySelect.replaceChildren();
append(retainedMemorySelect, 'option', { value: '' }, 'Select a retained memory');
setHidden(applicationSelection, true);
clearApprovalPreview(preserveConfirmationResult);
clearRejectionPreview(preserveConfirmationResult);
reviewDetailSummary.replaceChildren();
reviewDetailCandidates.replaceChildren();
reviewDetailRevisions.replaceChildren();
reviewDetailCandidateCount.textContent = 'Showing -- candidates';
reviewDetailRevisionCount.textContent = 'Showing -- revisions';
reviewDetailContent.setAttribute('aria-busy', 'false');
}

function clearReviewDetail(preserveReference = false, preserveConfirmationResult = false) {
clearRecordDetail();
memoryReviewDetailRequestSequence += 1;
reviewEntries = [];
if (!preserveReference) selectedReviewRef = null;
clearReviewDetailContent(preserveConfirmationResult);
hideReviewDetailStates();
}

function showReviewDetailState(state) {
hideReviewDetailStates();
reviewDetailContent.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
const states = {
unselected: reviewDetailUnselected,
loading: reviewDetailLoading,
malformed: reviewDetailMalformed,
error: reviewDetailError,
'not-found': reviewDetailNotFound,
stale: reviewDetailStale,
content: reviewDetailContent,
};
setHidden(states[state], false);
return state;
}

function selectedReview() {
const review = reviewEntries.find((entry) => entry.proposalRef === selectedReviewRef);
const scope = selectedReviewScope();
return review && scope ? {
...review,
scopeHandle: scope.handle,
scopeFingerprint: scope.fingerprint,
scopeExpiresAt: scope.expiresAt,
} : null;
}
function setReviewExpanded(button = null) { setExpanded(reviewsList, button); }

function selectReview(target) {
const button = target?.closest?.('[data-review-index]');
if (!button || !reviewsList.contains(button)) return null;
const index = Number(button.getAttribute('data-review-index'));
const review = Number.isInteger(index) ? reviewEntries[index] : null;
const scope = selectedReviewScope();
if (!review || !scope) return null;
if (review.proposalRef !== selectedReviewRef) clearReviewDetailContent();
selectedReviewRef = review.proposalRef;
setReviewExpanded(button);
return {
...review,
scopeHandle: scope.handle,
scopeFingerprint: scope.fingerprint,
scopeExpiresAt: scope.expiresAt,
};
}

function selectedScope() {
const index = Number(scopeSelect.value) - 1;
return Number.isInteger(index) && index >= 0 && index < catalog.length
? catalog[index]
: null;
}

function selectedReviewScope() {
const index = Number(reviewScopeSelect.value) - 1;
return Number.isInteger(index) && index >= 0 && index < reviewCatalog.length
? reviewCatalog[index]
: null;
}

function selectSubview(value) {
subview = value === 'reviews' ? 'reviews' : 'records';
const recordsSelected = subview === 'records';
if (recordsSelected) clearReviewDetail();
else clearRecordDetail();
recordsTab.setAttribute('aria-selected', recordsSelected ? 'true' : 'false');
recordsTab.tabIndex = recordsSelected ? 0 : -1;
reviewsTab.setAttribute('aria-selected', recordsSelected ? 'false' : 'true');
reviewsTab.tabIndex = recordsSelected ? -1 : 0;
setHidden(recordsPanel, !recordsSelected);
setHidden(reviewsPanel, recordsSelected);
refreshButton.disabled = false;
}

function selectedSubview() {
return subview;
}

function showSelection() {
hideStates();
clearRecordDetail();
setHidden(count, true);
setHidden(selection, false);
refreshButton.disabled = false;
}

function reset() {
catalog = [];
selectedFingerprint = null;
reviewCatalog = [];
selectedReviewFingerprint = null;
reviewEntries = [];
selectedReviewRef = null;
scopeSelect.replaceChildren(createElement('option', { value: '' }, 'Select a scope'));
reviewScopeSelect.replaceChildren(createElement('option', { value: '' }, 'Select a scope'));
scopeSelect.disabled = true;
reviewScopeSelect.disabled = true;
refreshButton.disabled = false;
setText(scopeNote, 'Choose one exact scope.');
setText(reviewScopeNote, 'Choose one exact scope.');
setText(count, 'Showing -- records');
setText(reviewsCount, 'Showing -- reviews');
list.replaceChildren();
reviewsList.replaceChildren();
clearReviewDetailContent();
hideStates();
hideReviewStates();
hideReviewDetailStates();
setHidden(count, true);
setHidden(reviewsCount, true);
selectSubview('records');
setHidden(view, true);
}

function setCatalogLoading() {
clearRecordDetail(true);
hideStates();
setHidden(count, true);
setHidden(scopeLoading, false);
scopeSelect.disabled = true;
refreshButton.disabled = true;
}

function showCatalogError() {
clearRecordDetail();
hideStates();
setHidden(count, true);
setHidden(scopeError, false);
scopeSelect.disabled = catalog.length === 0;
refreshButton.disabled = false;
}

function renderCatalog(body) {
const normalized = normalizeMemoryScopeCatalog(body);
if (!normalized) return null;
const retainedFingerprint = selectedFingerprint;
catalog = normalized.entries;
selectedFingerprint = null;
const placeholder = createElement('option', { value: '' }, 'Select a scope');
scopeSelect.replaceChildren(placeholder);
catalog.forEach((entry, index) => {
const option = createElement('option', { value: String(index + 1) },
entry.label + ' — scope ' + String(index + 1));
scopeSelect.append(option);
if (entry.fingerprint === retainedFingerprint) {
scopeSelect.value = String(index + 1);
selectedFingerprint = entry.fingerprint;
}
});
scopeSelect.disabled = catalog.length === 0;
refreshButton.disabled = false;
setText(
scopeNote,
normalized.truncated ? 'Showing the first 100 exact scopes.' : 'Choose one exact scope.',
);
hideStates();
setHidden(count, true);
if (catalog.length === 0) {
clearRecordDetail();
setHidden(scopeEmpty, false);
return { state: 'empty', selected: null };
}
const retained = selectedScope();
if (!retained) {
clearRecordDetail();
setHidden(selection, false);
return { state: 'selection', selected: null };
}
return { state: 'selected', selected: retained };
}

function selectScope() {
const previousFingerprint = selectedFingerprint;
const selected = selectedScope();
selectedFingerprint = selected?.fingerprint ?? null;
if (selectedFingerprint !== previousFingerprint) clearRecordDetail();
if (!selected) showSelection();
return selected;
}

function setRecordsLoading() {
clearRecordDetail(true);
hideStates();
setHidden(count, false);
setText(count, 'Showing -- records');
setHidden(recordsLoading, false);
content.setAttribute('aria-busy', 'true');
refreshButton.disabled = true;
}

function showRecordsError() {
clearRecordDetail();
hideStates();
setHidden(count, false);
setText(count, 'Showing -- records');
setHidden(recordsError, false);
content.setAttribute('aria-busy', 'false');
refreshButton.disabled = false;
}

function renderRecords(body, scopeKind) {
const normalized = normalizeMemoryRecordPage(body, scopeKind);
if (!normalized) return null;
recordEntries = normalized.entries;
if (!recordEntries.some((entry) => entry.recordRef === selectedRecordRef)) {
selectedRecordRef = null;
clearRecordDetailContent();
}
renderMemoryRecords(normalized, { list, selectedRecordRef });
hideStates();
setHidden(count, false);
setText(
count,
'Showing ' + normalized.entries.length + (normalized.entries.length === 1 ? ' record' : ' records')
+ (normalized.truncated ? ' - first 100 only' : ''),
);
content.setAttribute('aria-busy', 'false');
refreshButton.disabled = false;
setHidden(normalized.entries.length === 0 ? recordsEmpty : content, false);
if (normalized.entries.length === 0) {
clearRecordDetail();
} else if (!selectedRecordRef) {
showRecordDetailState('unselected');
}
const retainedRecord = selectedRecord();
if (retainedRecord) void loadMemoryRecordDetail(retainedRecord);
return normalized.entries.length === 0 ? 'empty' : 'content';
}

function setRecordDetailLoading() {
forgetWorkflow?.clear();
restoreWorkflow?.clear();
selectedRecordDetail = null;
showRecordDetailState('loading');
}

function showRecordDetailError(status) {
setExpanded(list);
return showRecordDetailState(status === 404 ? 'not-found' : 'error');
}
function renderRecordDetail(body, record) {
const state = renderMemoryRecordDetail(body, record, {
record: recordDetailRecord,
sources: recordDetailSources,
revisions: recordDetailRevisions,
audit: recordDetailAudit,
sourceCount: recordDetailSourceCount,
revisionCount: recordDetailRevisionCount,
auditCount: recordDetailAuditCount,
});
if (state === 'content') {
selectedRecordDetail = body;
forgetWorkflow.clear();
restoreWorkflow.clear();
forgetWorkflow.showUnrequested();
restoreWorkflow.showUnrequested();
} else {
selectedRecordDetail = null;
forgetWorkflow.clear();
restoreWorkflow.clear();
setExpanded(list);
}
updateRecordMutationControls();
return showRecordDetailState(state);
}

async function loadMemoryRecordDetail(selected) {
const requestSequence = ++memoryRecordDetailRequestSequence;
setRecordDetailLoading();
const result = await requestJson(
MEMORY_RECORD_DETAIL_ENDPOINT + selected.handle,
{ headers: { 'X-LetheBot-Scope': selected.scopeHandle } },
);
if (requestSequence !== memoryRecordDetailRequestSequence) return;
if (result.status === 401) {
showSessionExpired();
return;
}
if (result.status !== 200) {
const state = showRecordDetailError(result.status);
announce(state === 'not-found'
? 'Memory record provenance not found.'
: 'Memory record provenance unavailable.');
return;
}
const state = renderRecordDetail(result.body, selected);
announce(state === 'content'
? 'Memory record provenance updated.'
: state === 'stale'
? 'Memory record provenance changed.'
: 'Memory record provenance malformed.');
}

function setReviewCatalogLoading() {
const preserveConfirmationResult = (approvalRefreshRequested
&& !approvalConfirmationSucceeded.hidden)
|| (rejectionRefreshRequested && !rejectionConfirmationSucceeded.hidden);
approvalRefreshRequested = false;
rejectionRefreshRequested = false;
clearReviewDetail(true, preserveConfirmationResult);
hideReviewStates();
setHidden(reviewsCount, true);
setHidden(reviewScopeLoading, false);
reviewScopeSelect.disabled = true;
refreshButton.disabled = true;
}

function showReviewCatalogError() {
clearReviewDetail(false, confirmationResultVisible());
hideReviewStates();
setHidden(reviewsCount, true);
setHidden(reviewScopeError, false);
reviewScopeSelect.disabled = reviewCatalog.length === 0;
refreshButton.disabled = false;
}

function renderReviewCatalog(body) {
const normalized = normalizeMemoryReviewScopeCatalog(body);
if (!normalized) return null;
const retainedFingerprint = selectedReviewFingerprint;
reviewCatalog = normalized.entries;
selectedReviewFingerprint = null;
const placeholder = createElement('option', { value: '' }, 'Select a scope');
reviewScopeSelect.replaceChildren(placeholder);
reviewCatalog.forEach((entry, index) => {
const option = createElement('option', { value: String(index + 1) },
entry.label + ' — scope ' + String(index + 1));
reviewScopeSelect.append(option);
if (entry.fingerprint === retainedFingerprint) {
reviewScopeSelect.value = String(index + 1);
selectedReviewFingerprint = entry.fingerprint;
}
});
reviewScopeSelect.disabled = reviewCatalog.length === 0;
refreshButton.disabled = false;
setText(
reviewScopeNote,
normalized.truncated ? 'Showing the first 100 exact scopes.' : 'Choose one exact scope.',
);
hideReviewStates();
setHidden(reviewsCount, true);
if (reviewCatalog.length === 0) {
clearReviewDetail(false, confirmationResultVisible());
setHidden(reviewScopeEmpty, false);
return { state: 'empty', selected: null };
}
const retained = selectedReviewScope();
if (!retained) {
clearReviewDetail(false, confirmationResultVisible());
setHidden(reviewSelection, false);
return { state: 'selection', selected: null };
}
return { state: 'selected', selected: retained };
}

function selectReviewScope() {
const previousFingerprint = selectedReviewFingerprint;
const selected = selectedReviewScope();
selectedReviewFingerprint = selected?.fingerprint ?? null;
if (selectedReviewFingerprint !== previousFingerprint) clearReviewDetail();
if (!selected) {
hideReviewStates();
setHidden(reviewsCount, true);
setHidden(reviewSelection, false);
refreshButton.disabled = false;
}
return selected;
}

function setReviewsLoading() {
clearReviewDetail(true, confirmationResultVisible());
hideReviewStates();
setHidden(reviewsCount, false);
setText(reviewsCount, 'Showing -- reviews');
setHidden(reviewsLoading, false);
reviewsContent.setAttribute('aria-busy', 'true');
refreshButton.disabled = true;
}

function showReviewsError() {
clearReviewDetail(false, confirmationResultVisible());
hideReviewStates();
setHidden(reviewsCount, false);
setText(reviewsCount, 'Showing -- reviews');
setHidden(reviewsError, false);
reviewsContent.setAttribute('aria-busy', 'false');
refreshButton.disabled = false;
}

function renderReviews(body, scopeKind) {
const normalized = normalizeMemoryReviewPage(body, scopeKind);
if (!normalized) return null;
reviewEntries = normalized.entries;
if (!reviewEntries.some((entry) => entry.proposalRef === selectedReviewRef)) {
selectedReviewRef = null;
clearReviewDetailContent(confirmationResultVisible());
}
renderMemoryReviews(normalized, { list: reviewsList, selectedReviewRef });
hideReviewStates();
setHidden(reviewsCount, false);
setText(
reviewsCount,
'Showing ' + normalized.entries.length + (normalized.entries.length === 1 ? ' review' : ' reviews')
+ (normalized.truncated ? ' - first 100 only' : ''),
);
reviewsContent.setAttribute('aria-busy', 'false');
refreshButton.disabled = false;
setHidden(normalized.entries.length === 0 ? reviewsEmpty : reviewsContent, false);
if (normalized.entries.length === 0) {
clearReviewDetail(false, confirmationResultVisible());
} else if (!selectedReviewRef) {
showReviewDetailState('unselected');
}
const retainedReview = selectedReview();
if (retainedReview) void loadMemoryReviewDetail(retainedReview);
return normalized.entries.length === 0 ? 'empty' : 'content';
}

function setReviewDetailLoading() {
applicationWorkflow?.clear();
rollbackWorkflow?.clear();
expirationWorkflow?.clear();
clearApprovalPreview();
clearRejectionPreview();
showReviewDetailState('loading');
}

function showReviewDetailError(status) {
setReviewExpanded();
return showReviewDetailState(status === 404 ? 'not-found' : 'error');
}

function renderReviewDetail(body, review) {
const state = renderMemoryReviewDetail(body, review, {
summary: reviewDetailSummary,
candidates: reviewDetailCandidates,
revisions: reviewDetailRevisions,
candidateCount: reviewDetailCandidateCount,
revisionCount: reviewDetailRevisionCount,
});
showReviewDetailState(state);
if (state === 'content') {
selectedReviewDetail = body;
applicationWorkflow.clear();
rollbackWorkflow.clear();
expirationWorkflow.clear();
retainedMemorySelect.replaceChildren();
append(retainedMemorySelect, 'option', { value: '' }, 'Select a retained memory');
const needsSelection = body.lifecycleState === 'approved' && body.kind === 'conflict';
if (needsSelection) {
for (const candidate of body.candidates) append(retainedMemorySelect, 'option', {
value: candidate.memoryRef,
}, 'Memory ' + candidate.memoryRef);
}
setHidden(applicationSelection, !needsSelection);
applicationWorkflow.showUnrequested();
rollbackWorkflow.showUnrequested();
expirationWorkflow.showUnrequested();
showApprovalPreviewState('unrequested');
showRejectionPreviewState('unrequested');
}
if (state !== 'content') setReviewExpanded();
return state;
}

function reviewAuthorityMatches(expected) {
const current = selectedReview();
return current
&& current.proposalRef === expected.proposalRef
&& current.handle === expected.handle
&& current.handleExpiresAt === expected.handleExpiresAt
&& current.scopeHandle === expected.scopeHandle
&& current.scopeFingerprint === expected.scopeFingerprint
&& current.scopeExpiresAt === expected.scopeExpiresAt;
}

function approvalSelectionBinding(selected, detail, preview) {
return {
proposalRef: selected.proposalRef,
handle: selected.handle,
handleExpiresAt: selected.handleExpiresAt,
scopeHandle: selected.scopeHandle,
scopeFingerprint: selected.scopeFingerprint,
scopeExpiresAt: selected.scopeExpiresAt,
currentRevisionNumber: detail.currentRevisionNumber,
expectedRevisionNumber: preview.expected.revisionNumber,
};
}

function approvalSelectionMatches(binding) {
return reviewAuthorityMatches(binding)
&& selectedReviewDetail !== null
&& selectedReviewDetail.proposalRef === binding.proposalRef
&& selectedReviewDetail.lifecycleState === 'pending_review'
&& selectedReviewDetail.currentRevisionNumber === binding.currentRevisionNumber
&& binding.expectedRevisionNumber === binding.currentRevisionNumber + 1;
}

async function loadMemoryReviewDetail(selected) {
const requestSequence = ++memoryReviewDetailRequestSequence;
setReviewDetailLoading();
const result = await requestJson(
MEMORY_REVIEW_DETAIL_ENDPOINT + selected.handle,
{ headers: { 'X-LetheBot-Scope': selected.scopeHandle } },
);
if (requestSequence !== memoryReviewDetailRequestSequence) return;
if (result.status === 401) {
showSessionExpired();
return;
}
if (result.status !== 200) {
const state = showReviewDetailError(result.status);
announce(state === 'not-found'
? 'Memory review detail not found.'
: 'Memory review detail unavailable.');
return;
}
const state = renderReviewDetail(result.body, selected);
announce(state === 'content'
? 'Memory review detail updated.'
: state === 'stale'
? 'Memory review detail changed.'
: 'Memory review detail malformed.');
}

async function loadMemoryApprovalPreview(selected) {
if (approvalPreviewButton.disabled || selectedReviewDetail === null) return;
const detail = selectedReviewDetail;
const requestSequence = ++memoryApprovalPreviewRequestSequence;
expirationWorkflow.clear();
clearRejectionPreview();
if (memoryApprovalPreviewExpiryTimer !== null) {
window.clearTimeout(memoryApprovalPreviewExpiryTimer);
memoryApprovalPreviewExpiryTimer = null;
}
clearApprovalConfirmation();
approvalPreviewEvidence.replaceChildren();
showApprovalPreviewState('loading');
const result = await requestMemoryMutation(
MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + selected.handle,
selected.scopeHandle,
{ action: 'approve' },
);
if (requestSequence !== memoryApprovalPreviewRequestSequence) return;
if (!reviewAuthorityMatches(selected) || selectedReviewDetail !== detail) {
showApprovalPreviewState('stale');
announce('Approval preview changed.');
return;
}
if (result.status === 401) {
showSessionExpired();
return;
}
if (result.status !== 201) {
const state = result.status === 404
? 'not-found'
: result.status === 409
? 'stale'
: 'unavailable';
showApprovalPreviewState(state);
announce(state === 'not-found'
? 'Approval preview not found.'
: state === 'stale'
? 'Approval preview changed.'
: 'Approval preview unavailable.');
return;
}
const rendered = renderMemoryApprovalPreview(
result.body,
selected,
detail,
{ evidence: approvalPreviewEvidence },
Date.now(),
);
showApprovalPreviewState(rendered.state);
if (rendered.state === 'populated') {
approvalConfirmationAuthority = {
previewHandle: result.body.previewHandle,
expiresAt: rendered.preview.previewExpiresAt,
selection: approvalSelectionBinding(selected, detail, rendered.preview),
};
updateApprovalControls();
scheduleApprovalPreviewExpiry(rendered.preview.previewExpiresAt, requestSequence);
announce('Approval preview updated.');
return;
}
announce(rendered.state === 'stale'
? 'Approval preview changed.'
: 'Approval preview malformed.');
}

async function loadMemoryRejectionPreview(selected) {
if (rejectionPreviewButton.disabled || selectedReviewDetail === null) return;
const detail = selectedReviewDetail;
const requestSequence = ++memoryRejectionPreviewRequestSequence;
expirationWorkflow.clear();
if (memoryRejectionPreviewExpiryTimer !== null) {
window.clearTimeout(memoryRejectionPreviewExpiryTimer);
memoryRejectionPreviewExpiryTimer = null;
}
clearApprovalPreview(false, true);
clearRejectionConfirmation();
rejectionPreviewEvidence.replaceChildren();
showRejectionPreviewState('loading');
const result = await requestMemoryMutation(
MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + selected.handle,
selected.scopeHandle,
{ action: 'reject' },
);
if (requestSequence !== memoryRejectionPreviewRequestSequence) return;
if (!reviewAuthorityMatches(selected) || selectedReviewDetail !== detail) {
showRejectionPreviewState('stale');
announce('Rejection preview changed.');
return;
}
if (result.status === 401) {
showSessionExpired();
return;
}
if (result.status !== 201) {
const state = result.status === 404
? 'not-found'
: result.status === 409
? 'stale'
: 'unavailable';
showRejectionPreviewState(state);
announce(state === 'not-found'
? 'Rejection preview not found.'
: state === 'stale'
? 'Rejection preview changed.'
: 'Rejection preview unavailable.');
return;
}
const rendered = renderMemoryRejectionPreview(
result.body,
selected,
detail,
{ evidence: rejectionPreviewEvidence },
Date.now(),
);
showRejectionPreviewState(rendered.state);
if (rendered.state === 'populated') {
rejectionConfirmationAuthority = {
previewHandle: result.body.previewHandle,
expiresAt: rendered.preview.previewExpiresAt,
selection: approvalSelectionBinding(selected, detail, rendered.preview),
};
updateApprovalControls();
scheduleRejectionPreviewExpiry(rendered.preview.previewExpiresAt, requestSequence);
announce('Rejection preview updated.');
return;
}
announce(rendered.state === 'stale'
? 'Rejection preview changed.'
: 'Rejection preview malformed.');
}

async function confirmMemoryApproval() {
const authority = approvalConfirmationAuthority;
if (approvalConfirmationButton.disabled || authority === null) return;
const selected = selectedReview();
if (!selected
|| authority.expiresAt <= Date.now()
|| !approvalSelectionMatches(authority.selection)) {
clearApprovalConfirmationAuthority();
approvalPreviewEvidence.replaceChildren();
showApprovalPreviewState('stale');
announce('Approval preview changed.');
return;
}
const expected = {
proposalRef: authority.selection.proposalRef,
expectedRevisionNumber: authority.selection.expectedRevisionNumber,
};
approvalConfirmationAuthority = null;
approvalConfirmationInFlight = true;
const requestSequence = ++memoryApprovalConfirmationRequestSequence;
if (memoryApprovalPreviewExpiryTimer !== null) {
window.clearTimeout(memoryApprovalPreviewExpiryTimer);
memoryApprovalPreviewExpiryTimer = null;
}
showApprovalConfirmationState('confirming');
const result = await requestMemoryMutation(
MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + selected.handle
+ MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX,
selected.scopeHandle,
{ confirm: true, previewHandle: authority.previewHandle },
);
if (requestSequence !== memoryApprovalConfirmationRequestSequence) return;
approvalConfirmationInFlight = false;
if (result.status === 401) {
showSessionExpired();
return;
}
if (result.status !== 200) {
const state = result.status === 404
? 'not-found'
: result.status === 409
? 'conflict'
: 'unavailable';
showApprovalConfirmationState(state);
announce(state === 'not-found'
? 'Approval confirmation not found.'
: state === 'conflict'
? 'Approval confirmation changed.'
: 'Approval confirmation unavailable.');
return;
}
const rendered = renderMemoryApprovalConfirmation(
result.body,
expected,
{ evidence: approvalConfirmationEvidence },
);
showApprovalConfirmationState(rendered.state);
if (rendered.state !== 'succeeded') {
announce('Approval result malformed.');
return;
}
clearReviewDetail(false, true);
announce('Approval confirmed.');
approvalRefreshRequested = true;
refreshButton.click();
}

async function confirmMemoryRejection() {
const authority = rejectionConfirmationAuthority;
if (rejectionConfirmationButton.disabled || authority === null) return;
const selected = selectedReview();
if (!selected
|| authority.expiresAt <= Date.now()
|| !approvalSelectionMatches(authority.selection)) {
clearRejectionConfirmationAuthority();
rejectionPreviewEvidence.replaceChildren();
showRejectionPreviewState('stale');
announce('Rejection preview changed.');
return;
}
const expected = {
proposalRef: authority.selection.proposalRef,
expectedRevisionNumber: authority.selection.expectedRevisionNumber,
};
rejectionConfirmationAuthority = null;
rejectionConfirmationInFlight = true;
const requestSequence = ++memoryRejectionConfirmationRequestSequence;
if (memoryRejectionPreviewExpiryTimer !== null) {
window.clearTimeout(memoryRejectionPreviewExpiryTimer);
memoryRejectionPreviewExpiryTimer = null;
}
showRejectionConfirmationState('confirming');
const result = await requestMemoryMutation(
MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + selected.handle
+ MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX,
selected.scopeHandle,
{ confirm: true, previewHandle: authority.previewHandle, action: 'reject' },
);
if (requestSequence !== memoryRejectionConfirmationRequestSequence) return;
rejectionConfirmationInFlight = false;
if (result.status === 401) {
showSessionExpired();
return;
}
if (result.status !== 200) {
const state = result.status === 404
? 'not-found'
: result.status === 409
? 'conflict'
: 'unavailable';
showRejectionConfirmationState(state);
announce(state === 'not-found'
? 'Rejection confirmation not found.'
: state === 'conflict'
? 'Rejection confirmation changed.'
: 'Rejection confirmation unavailable.');
return;
}
const rendered = renderMemoryRejectionConfirmation(
result.body,
expected,
{ evidence: rejectionConfirmationEvidence },
);
showRejectionConfirmationState(rendered.state);
if (rendered.state !== 'succeeded') {
announce('Rejection result malformed.');
return;
}
clearReviewDetail(false, true);
announce('Rejection confirmed.');
rejectionRefreshRequested = true;
refreshButton.click();
}

const requestRecordMutation = (handle, scopeHandle, body, confirm = false) => requestMemoryMutation(
MEMORY_RECORD_DETAIL_ENDPOINT + handle + (confirm ? '/confirm' : ''),
scopeHandle,
body,
);
forgetWorkflow = createMemoryRecordMutationWorkflow(
MEMORY_RECORD_FORGET_WORKFLOW,
{
parent: recordDetailContent,
setHidden,
request: requestRecordMutation,
showSessionExpired,
announce,
getCurrent: () => ({
selected: selectedRecord(),
detail: selectedRecordDetail,
}),
onStateChange: updateRecordMutationControls,
onBeforePreview: () => restoreWorkflow?.clear(),
onSuccess: () => {
clearRecordDetail(false, true);
refreshButton.click();
},
},
);
restoreWorkflow = createMemoryRecordMutationWorkflow(
MEMORY_RECORD_RESTORE_WORKFLOW,
{
parent: recordDetailContent,
setHidden,
request: requestRecordMutation,
showSessionExpired,
announce,
getCurrent: () => ({
selected: selectedRecord(),
detail: selectedRecordDetail,
}),
onStateChange: updateRecordMutationControls,
onBeforePreview: () => forgetWorkflow.clear(),
onSuccess: () => {
clearRecordDetail(false, true);
refreshButton.click();
},
},
);
updateRecordMutationControls();

applicationWorkflow = createMemoryApplicationWorkflow({
button: applicationPreviewButton,
retainedSelect: retainedMemorySelect,
evidence: applicationPreviewEvidence,
previewStates: applicationPreviewStateElements,
parent: applicationPreviewStateElements[6].parentElement,
setHidden,
request: (handle, scopeHandle, body, confirm = false) => requestMemoryMutation(
MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + handle
+ (confirm ? MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX : ''),
scopeHandle,
body,
),
showSessionExpired,
announce,
getCurrent: () => ({ selected: selectedReview(), detail: selectedReviewDetail }),
authorityMatches: reviewAuthorityMatches,
onStateChange: updateApprovalControls,
onSuccess: () => {
clearReviewDetail(false, true);
refreshButton.click();
},
});
const transitionOptions = {
parent: reviewDetailContent,
setHidden,
request: (handle, scopeHandle, body, confirm = false) => requestMemoryMutation(
MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + handle
+ (confirm ? MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX : ''),
scopeHandle,
body,
),
showSessionExpired,
announce,
getCurrent: () => ({ selected: selectedReview(), detail: selectedReviewDetail }),
authorityMatches: reviewAuthorityMatches,
onStateChange: updateApprovalControls,
onSuccess: () => {
clearReviewDetail(false, true);
refreshButton.click();
},
};
rollbackWorkflow = createMemoryMaintenanceTransitionWorkflow(
MEMORY_ROLLBACK_WORKFLOW,
{
...transitionOptions,
onBeforePreview: () => {
applicationWorkflow.clear();
expirationWorkflow?.clear();
clearApprovalPreview(false, true);
clearRejectionPreview();
},
},
);
expirationWorkflow = createMemoryMaintenanceTransitionWorkflow(
MEMORY_EXPIRATION_WORKFLOW,
{
...transitionOptions,
onBeforePreview: () => {
applicationWorkflow.clear();
rollbackWorkflow.clear();
clearApprovalPreview(false, true);
clearRejectionPreview();
},
},
);
updateApprovalControls();

reviewsList.addEventListener('click', (event) => {
const selected = selectReview(event.target);
if (selected) void loadMemoryReviewDetail(selected);
});

approvalPreviewButton.addEventListener('click', () => {
const selected = selectedReview();
if (selected) void loadMemoryApprovalPreview(selected);
});

approvalConfirmationButton.addEventListener('click', () => {
void confirmMemoryApproval();
});

rejectionPreviewButton.addEventListener('click', () => {
const selected = selectedReview();
if (selected) void loadMemoryRejectionPreview(selected);
});

rejectionConfirmationButton.addEventListener('click', () => {
void confirmMemoryRejection();
});

list.addEventListener('click', (event) => {
const selected = selectRecord(event.target);
if (selected) void loadMemoryRecordDetail(selected);
});

return {
scopesEndpoint: MEMORY_SCOPES_ENDPOINT,
recordsEndpoint: MEMORY_RECORDS_ENDPOINT,
reviewScopesEndpoint: MEMORY_REVIEW_SCOPES_ENDPOINT,
reviewsEndpoint: MEMORY_REVIEWS_ENDPOINT,
nav,
view,
refreshButton,
recordsTab,
reviewsTab,
scopeSelect,
reviewScopeSelect,
reviewsList,
reset,
selectSubview,
selectedSubview,
setCatalogLoading,
showCatalogError,
renderCatalog,
selectScope,
setRecordsLoading,
showRecordsError,
renderRecords,
clearRecordDetail,
selectedRecord,
selectRecord,
setRecordDetailLoading,
showRecordDetailError,
renderRecordDetail,
setReviewCatalogLoading,
showReviewCatalogError,
renderReviewCatalog,
selectReviewScope,
setReviewsLoading,
showReviewsError,
renderReviews,
clearReviewDetail,
selectedReview,
selectReview,
setReviewDetailLoading,
showReviewDetailError,
renderReviewDetail,
approvalPreviewButton,
};
}