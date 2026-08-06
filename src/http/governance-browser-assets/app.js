import { createActivityFeature } from '/governance/activity.js';
import { createIdentityFeature, createOperationsFeature } from '/governance/administration.js';
import { createDisplayProfileFeature } from '/governance/display-profile.js';
import { createExplainFeature } from '/governance/explain.js';
import { createGroupSummaryFeature } from '/governance/group-summary.js';
import { createMemoryFeature } from '/governance/memory.js';
import { createPrivacyFeature } from '/governance/privacy.js';
const SESSION_ENDPOINT = '/governance/api/v1/session';
const OVERVIEW_ENDPOINT = '/governance/api/v1/overview';
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;


function bindElements(ids) {
  return Object.fromEntries(
    Object.entries(ids).map(([key, id]) => [key, document.getElementById(id)]),
  );
}

const elements = bindElements({
  loginView: 'login-view',
  loginForm: 'login-form',
  tokenInput: 'admin-token',
  loginButton: 'login-button',
  loginError: 'login-error',
  overviewView: 'overview-view',
  overviewLoading: 'overview-loading',
  overviewError: 'overview-error',
  metricGrid: 'metric-grid',
  refreshButton: 'refresh-button',
  overviewNav: 'overview-nav',
  activityNav: 'activity-nav',
  activityView: 'activity-view',
  activityLoading: 'activity-loading',
  activityError: 'activity-error',
  activityEmpty: 'activity-empty',
  activityContent: 'activity-content',
  activityRefreshButton: 'activity-refresh-button',
  activityTotal: 'activity-total',
  activityGeneratedAt: 'activity-generated-at',
  modelInvocationsTab: 'model-invocations-tab',
  modelInvocationsPanel: 'model-invocations-panel',
  logoutButton: 'logout-button',
  sessionSummary: 'session-summary',
  sessionExpiry: 'session-expiry',
  navigation: 'primary-navigation',
  attentionState: 'attention-state',
  attentionTotal: 'attention-total',
  generatedAt: 'generated-at',
  main: 'main-content',
  liveRegion: 'live-region',
});

const [
  ACTIVITY_ENDPOINT,
  activityListDefinitions,
  renderActivity,
] = createActivityFeature(
  elements,
  setText,
  formatGeneratedAt,
  boundedNumber,
);

const memoryFeature = createMemoryFeature(
  elements,
  setHidden,
  setText,
  requestJson,
  (path, scopeHandle, body) => requestJson(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    },
    body: JSON.stringify(body),
  }),
  showSessionExpired,
  announce,
);

const explainFeature = createExplainFeature(
  elements,
  setHidden,
  requestJson,
  showSessionExpired,
  announce,
);

const privacyFeature = createPrivacyFeature(
  elements,
  setHidden,
  requestJson,
  (path, scopeHandle, body) => requestJson(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    },
    body: JSON.stringify(body),
  }),
  showSessionExpired,
  announce,
);

const groupSummaryFeature = createGroupSummaryFeature(
  elements,
  setHidden,
  requestJson,
  (path, scopeHandle, body) => requestJson(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    },
    body: JSON.stringify(body),
  }),
  showSessionExpired,
  announce,
);

const displayProfileFeature = createDisplayProfileFeature(
  elements,
  setHidden,
  requestJson,
  (path, scopeHandle, body) => requestJson(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    },
    body: JSON.stringify(body),
  }),
  showSessionExpired,
  announce,
);

const unscopedMutation = (path, body) => requestJson(path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-LetheBot-CSRF': csrfToken,
  },
  body: JSON.stringify(body),
});
const identityFeature = createIdentityFeature(
  elements,
  setHidden,
  unscopedMutation,
  showSessionExpired,
  announce,
);
const operationsFeature = createOperationsFeature(
  elements,
  setHidden,
  requestJson,
  unscopedMutation,
  showSessionExpired,
  announce,
);

function appendElement(parent, tag, attributes = {}, text) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function buildActivityListShell(definition) {
  const [
    view,
    prefix,
    label,
    eyebrow,
    noun,
    descriptionSubject,
    caption,
    columns,
    endpoint,
    render,
  ] = definition;
  const isTool = view === 'tools';
  const isWorker = view === 'workers';
  const isDecision = view === 'decisions';
  const tab = appendElement(document.querySelector('.activity-tabs'), 'button', {
    id: prefix + '-tab',
    class: 'activity-tab',
    type: 'button',
    role: 'tab',
    'aria-selected': 'false',
    'aria-controls': prefix + '-panel',
    tabindex: '-1',
  }, label);
  const panel = appendElement(elements.activityView, 'section', {
    id: prefix + '-panel',
    class: 'activity-panel',
    role: 'tabpanel',
    'aria-labelledby': prefix + '-tab',
    hidden: '',
  });
  const header = appendElement(panel, 'header', {
    class: 'view-toolbar activity-panel-toolbar',
  });
  if (eyebrow) {
    const title = appendElement(header, 'div');
    appendElement(title, 'p', { class: 'eyebrow' }, eyebrow);
    appendElement(title, 'h2', {}, label);
  } else {
    appendElement(header, 'h2', {}, label);
  }
  appendElement(header, 'button', {
    id: prefix + '-refresh-button',
    class: 'button button-secondary',
    type: 'button',
  }, 'Refresh');
  appendElement(panel, 'p', {
    id: prefix + '-count',
    class: isTool || isDecision ? 'tool-calls-count' : 'worker-heartbeats-count',
  }, 'Showing -- ' + noun);
  const loading = appendElement(panel, 'div', {
    id: prefix + '-loading',
    class: isTool ? 'tool-calls-skeleton' : 'worker-heartbeats-skeleton',
    'aria-hidden': 'true',
    hidden: '',
  });
  for (let row = 0; row < (isDecision ? 1 : 4); row += 1) {
    const skeletonRow = appendElement(loading, 'div');
    for (let column = 0; column < (isTool ? 3 : 4); column += 1) {
      appendElement(skeletonRow, 'span');
    }
  }
  for (const [suffix, className, role, title, description] of [
    ['error', 'error-band', 'alert', label + ' unavailable',
      descriptionSubject ? 'Refresh the local ' + descriptionSubject + '.' : null],
    ['empty', 'empty-band', 'status', 'No ' + label.toLowerCase() + ' recorded',
      descriptionSubject ? 'Recorded ' + descriptionSubject + ' will appear here.' : null],
  ]) {
    const state = appendElement(panel, 'section', {
      id: prefix + '-' + suffix,
      class: className,
      role,
      hidden: '',
    });
    appendElement(state, 'h2', {}, title);
    if (description) appendElement(state, 'p', {}, description);
  }
  const content = appendElement(panel, 'div', {
    id: prefix + '-content',
    class: isTool ? 'tool-calls-content' : 'worker-heartbeats-content',
    ...(!isDecision ? { 'aria-busy': 'false' } : {}),
    hidden: '',
  });
  const table = appendElement(content, 'table', {
    id: prefix + '-table',
    class: isTool
      ? 'tool-calls-table'
      : 'worker-heartbeats-table' + (isWorker ? '' : ' jobs-table'),
    ...(!isDecision ? { role: 'table' } : {}),
  });
  appendElement(table, 'caption', { class: 'sr-only' }, caption);
  if (columns.some(([, columnClass]) => columnClass)) {
    const colgroup = appendElement(table, 'colgroup');
    for (const [, columnClass] of columns) {
      appendElement(colgroup, 'col', { class: columnClass });
    }
  }
  const row = appendElement(appendElement(table, 'thead'), 'tr');
  for (const [heading] of columns) {
    appendElement(row, 'th', { scope: 'col' }, heading);
  }
  appendElement(table, 'tbody', { id: prefix + '-list' });
  return {
    view,
    prefix,
    request: () => requestJson(endpoint),
    render,
    loadingCount: 'Showing -- ' + noun,
    unavailableMessage: label + ' unavailable.',
    emptyMessage: 'No ' + label.toLowerCase() + ' recorded.',
    updatedMessage: label + ' updated.',
  };
}

function createActivityListController(config) {
  const element = (suffix) => document.getElementById(config.prefix + '-' + suffix);
  return {
    ...config,
    requestSequence: 0,
    tab: element('tab'),
    panel: element('panel'),
    refreshButton: element('refresh-button'),
    loading: element('loading'),
    error: element('error'),
    empty: element('empty'),
    content: element('content'),
    count: element('count'),
    list: element('list'),
  };
}

const activityListControllers = activityListDefinitions.map(
  (definition) => createActivityListController(buildActivityListShell(definition)),
);

const activityTabs = [
  {
    view: 'models',
    tab: elements.modelInvocationsTab,
    panel: elements.modelInvocationsPanel,
  },
  ...activityListControllers,
];

const metricBindings = [
  ['memory-total', ['memoryReviews', 'total']],
  ['memory-unresolved', ['memoryReviews', 'unresolved']],
  ['memory-resolved', ['memoryReviews', 'resolved']],
  ['jobs-pending', ['jobs', 'pending']],
  ['jobs-running', ['jobs', 'running']],
  ['jobs-failed', ['jobs', 'failed']],
  ['workers-total', ['workerHeartbeats', 'total']],
  ['workers-error', ['workerHeartbeats', 'error']],
  ['workers-expired', ['jobs', 'expiredRunningLeases']],
  ['actions-decisions', ['actions', 'decisions', 'total']],
  ['actions-executions', ['actions', 'executions', 'total']],
  ['actions-failed', ['actions', 'executions', 'failedOrRejected']],
  ['tools-total', ['tools', 'total']],
  ['tools-failed', ['tools', 'failedOrRejected']],
  ['tools-redacted', ['tools', 'secretsRedacted']],
  ['events-failed', ['eventProcessing', 'failuresTotal']],
  ['audit-total', ['audit', 'total']],
  ['audit-high-risk', ['audit', 'highRisk']],
];

const attentionPaths = [
  ['unresolvedMemoryReviews'],
  ['failedJobs'],
  ['expiredRunningLeases'],
  ['errorWorkerHeartbeats'],
  ['failedOrRejectedActions'],
  ['failedOrRejectedToolCalls'],
  ['eventProcessingFailures'],
  ['highOrProhibitedRiskAuditEvents'],
];



let csrfToken = null;
let overviewRequestSequence = 0;
let activityRequestSequence = 0;
let memoryCatalogRequestSequence = 0;
let memoryRecordsRequestSequence = 0;
let memoryReviewCatalogRequestSequence = 0;
let memoryReviewsRequestSequence = 0;

function setHidden(element, hidden) {
  if (element) {
    element.hidden = hidden;
  }
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function announce(message) {
  setText(elements.liveRegion, '');
  window.setTimeout(() => setText(elements.liveRegion, message), 0);
}

function showSessionExpired() {
  showLogin('Session expired.');
  announce('Session expired.');
}

function setActiveNavigation(activeView) {
  for (const [view, element] of [
    ['overview', elements.overviewNav],
    ['memory', memoryFeature.nav],
    ['explain', explainFeature.nav],
    ['privacy', privacyFeature.nav],
    ['group-summary', groupSummaryFeature.nav],
    ['display-profile', displayProfileFeature.nav],
    ['identity', identityFeature.nav],
    ['operations', operationsFeature.nav],
    ['activity', elements.activityNav],
  ]) {
    if (view === activeView) {
      element?.setAttribute('aria-current', 'page');
    } else {
      element?.removeAttribute('aria-current');
    }
  }
}

function setActiveActivityTab(activeView) {
  for (const { view, tab, panel } of activityTabs) {
    const selected = view === activeView;
    tab?.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (tab) {
      tab.tabIndex = selected ? 0 : -1;
    }
    setHidden(panel, !selected);
  }
}

function cancelInactiveActivityRequests(activeView) {
  if (activeView !== 'models') {
    activityRequestSequence += 1;
  }
  for (const controller of activityListControllers) {
    if (controller.view !== activeView) {
      controller.requestSequence += 1;
    }
  }
}

function selectActivitySubview(view) {
  cancelInactiveActivityRequests(view);
  setActiveActivityTab(view);
}

function cancelMemoryRequests() {
  memoryCatalogRequestSequence += 1;
  memoryRecordsRequestSequence += 1;
  memoryReviewCatalogRequestSequence += 1;
  memoryReviewsRequestSequence += 1;
  memoryFeature.clearReviewDetail();
}

function selectMemorySubview(view) {
  if (view !== 'records') {
    memoryCatalogRequestSequence += 1;
    memoryRecordsRequestSequence += 1;
  }
  if (view !== 'reviews') {
    memoryReviewCatalogRequestSequence += 1;
    memoryReviewsRequestSequence += 1;
  }
  memoryFeature.selectSubview(view);
}

function selectView(view) {
  const activitySelected = view === 'activity';
  const memorySelected = view === 'memory';
  const explainSelected = view === 'explain';
  const privacySelected = view === 'privacy';
  const groupSummarySelected = view === 'group-summary';
  const displayProfileSelected = view === 'display-profile';
  const identitySelected = view === 'identity';
  const operationsSelected = view === 'operations';
  if (view !== 'overview') {
    overviewRequestSequence += 1;
  }
  if (!activitySelected) {
    cancelInactiveActivityRequests(null);
  }
  if (!memorySelected) {
    cancelMemoryRequests();
  }
  if (!explainSelected) {
    explainFeature.reset();
  }
  if (!privacySelected) {
    privacyFeature.reset();
  }
  if (!groupSummarySelected) {
    groupSummaryFeature.reset();
  }
  if (!displayProfileSelected) {
    displayProfileFeature.reset();
  }
  if (!identitySelected) {
    identityFeature.reset();
  }
  if (!operationsSelected) {
    operationsFeature.reset();
  }
  setHidden(elements.overviewView, view !== 'overview');
  setHidden(memoryFeature.view, !memorySelected);
  setHidden(explainFeature.view, !explainSelected);
  setHidden(privacyFeature.view, !privacySelected);
  setHidden(groupSummaryFeature.view, !groupSummarySelected);
  setHidden(displayProfileFeature.view, !displayProfileSelected);
  setHidden(identityFeature.view, !identitySelected);
  setHidden(operationsFeature.view, !operationsSelected);
  setHidden(elements.activityView, !activitySelected);
  setActiveNavigation(view);
  elements.main?.focus();
}

function showLogin(message) {
  csrfToken = null;
  overviewRequestSequence += 1;
  cancelInactiveActivityRequests(null);
  cancelMemoryRequests();
  memoryFeature.reset();
  explainFeature.reset();
  privacyFeature.reset();
  groupSummaryFeature.reset();
  displayProfileFeature.reset();
  identityFeature.reset();
  operationsFeature.reset();
  setHidden(elements.loginView, false);
  setHidden(elements.overviewView, true);
  setHidden(memoryFeature.view, true);
  setHidden(elements.activityView, true);
  setHidden(elements.navigation, true);
  setHidden(elements.sessionSummary, true);
  setActiveNavigation('overview');
  setActiveActivityTab('models');
  setHidden(elements.loginError, !message);
  setText(elements.loginError, message || '');
  if (elements.loginButton) {
    elements.loginButton.disabled = false;
  }
  if (elements.tokenInput) {
    elements.tokenInput.value = '';
    elements.tokenInput.focus();
  }
}

function showOverview(expiresAt) {
  setHidden(elements.loginView, true);
  setHidden(elements.navigation, false);
  setHidden(elements.sessionSummary, false);
  setText(elements.sessionExpiry, formatExpiry(expiresAt));
  selectView('overview');
}

function formatExpiry(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? 'Expires ' + new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date)
    : 'Expiry unavailable';
}

function formatGeneratedAt(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? 'Updated: ' + new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(date)
    : 'Updated: unavailable';
}

function boundedNumber(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? Math.trunc(value)
    : null;
}

function boundedNumberAt(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = current[key];
  }
  return boundedNumber(current);
}



function renderOverview(summary) {
  for (const [id, path] of metricBindings) {
    const value = boundedNumberAt(summary, path);
    setText(document.getElementById(id), value === null ? 'Unavailable' : value.toLocaleString());
  }

  const attentionValues = attentionPaths.map((path) => boundedNumberAt(summary?.attention, path));
  const availableValues = attentionValues.filter((value) => value !== null);
  const attentionTotal = availableValues.reduce((total, value) => total + value, 0);
  const attentionAvailable = availableValues.length === attentionValues.length;
  setText(elements.attentionTotal, attentionAvailable ? attentionTotal.toLocaleString() : '--');
  if (elements.attentionState) {
    elements.attentionState.className = attentionAvailable
      ? attentionTotal > 0
        ? 'state-badge state-attention'
        : 'state-badge state-healthy'
      : 'state-badge state-unavailable';
  }
  setText(
    elements.attentionState,
    attentionAvailable ? attentionTotal > 0 ? 'Attention' : 'Healthy' : 'Unavailable',
  );
  setText(elements.generatedAt, formatGeneratedAt(summary?.generatedAt));
}





function setOverviewLoading(loading) {
  setHidden(elements.overviewLoading, !loading);
  setHidden(elements.metricGrid, loading);
  setHidden(elements.overviewError, true);
  elements.metricGrid?.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.refreshButton) {
    elements.refreshButton.disabled = loading;
  }
}

function setActivityLoading(loading) {
  setHidden(elements.activityLoading, !loading);
  setHidden(elements.activityContent, true);
  setHidden(elements.activityEmpty, true);
  setHidden(elements.activityError, true);
  elements.activityContent?.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.activityRefreshButton) {
    elements.activityRefreshButton.disabled = loading;
  }
  if (loading) {
    setText(elements.activityTotal, '--');
    setText(elements.activityGeneratedAt, 'Updated: unavailable');
  }
}

function setActivityListLoading(controller, loading) {
  setHidden(controller.loading, !loading);
  setHidden(controller.content, true);
  setHidden(controller.empty, true);
  setHidden(controller.error, true);
  controller.content?.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (controller.refreshButton) {
    controller.refreshButton.disabled = loading;
  }
  if (loading) {
    setText(controller.count, controller.loadingCount);
  }
}

async function requestJson(path, init) {
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
      ...init,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function loadOverview() {
  const requestSequence = ++overviewRequestSequence;
  setOverviewLoading(true);
  const result = await requestJson(OVERVIEW_ENDPOINT);
  if (requestSequence !== overviewRequestSequence) {
    return;
  }
  setOverviewLoading(false);
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200 || !result.body || typeof result.body !== 'object') {
    setHidden(elements.metricGrid, true);
    setHidden(elements.overviewError, false);
    announce('Overview unavailable.');
    return;
  }
  renderOverview(result.body);
  setHidden(elements.metricGrid, false);
  announce('Overview updated.');
}

async function loadActivity() {
  const requestSequence = ++activityRequestSequence;
  setActivityLoading(true);
  const result = await requestJson(ACTIVITY_ENDPOINT);
  if (requestSequence !== activityRequestSequence) {
    return;
  }
  setActivityLoading(false);
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200) {
    setHidden(elements.activityError, false);
    announce('Activity unavailable.');
    return;
  }
  const state = renderActivity(result.body);
  if (state === null) {
    setHidden(elements.activityError, false);
    announce('Activity unavailable.');
    return;
  }
  setHidden(elements.activityContent, state !== 'content');
  setHidden(elements.activityEmpty, state !== 'empty');
  announce(state === 'empty' ? 'No model invocations recorded.' : 'Activity updated.');
}

async function loadActivityList(controller) {
  const requestSequence = ++controller.requestSequence;
  setActivityListLoading(controller, true);
  const result = await controller.request();
  if (requestSequence !== controller.requestSequence) {
    return;
  }
  setActivityListLoading(controller, false);
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200) {
    setHidden(controller.error, false);
    announce(controller.unavailableMessage);
    return;
  }
  const state = controller.render(result.body, controller);
  if (state === null) {
    setHidden(controller.error, false);
    announce(controller.unavailableMessage);
    return;
  }
  setHidden(controller.content, state !== 'content');
  setHidden(controller.empty, state !== 'empty');
  announce(state === 'empty' ? controller.emptyMessage : controller.updatedMessage);
}

async function loadMemoryCatalog() {
  const requestSequence = ++memoryCatalogRequestSequence;
  memoryRecordsRequestSequence += 1;
  memoryFeature.setCatalogLoading();
  const result = await requestJson(memoryFeature.scopesEndpoint);
  if (requestSequence !== memoryCatalogRequestSequence) {
    return;
  }
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200) {
    memoryFeature.showCatalogError();
    announce('Memory scopes unavailable.');
    return;
  }
  const state = memoryFeature.renderCatalog(result.body);
  if (!state) {
    memoryFeature.showCatalogError();
    announce('Memory scopes unavailable.');
    return;
  }
  if (state.selected) {
    await loadMemoryRecords(state.selected);
    return;
  }
  announce(state.state === 'empty' ? 'No memory scopes.' : 'Select a memory scope.');
}

async function loadMemoryRecords(selected) {
  const requestSequence = ++memoryRecordsRequestSequence;
  memoryFeature.setRecordsLoading();
  const result = await requestJson(memoryFeature.recordsEndpoint, {
    headers: {
      Accept: 'application/json',
      'X-LetheBot-Scope': selected.handle,
    },
  });
  if (requestSequence !== memoryRecordsRequestSequence) {
    return;
  }
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200) {
    memoryFeature.showRecordsError();
    announce('Memory records unavailable.');
    return;
  }
  const state = memoryFeature.renderRecords(result.body, selected.scopeKind);
  if (state === null) {
    memoryFeature.showRecordsError();
    announce('Memory records unavailable.');
    return;
  }
  announce(state === 'empty' ? 'No memory records.' : 'Memory records updated.');
}

async function loadMemoryReviewCatalog() {
  const requestSequence = ++memoryReviewCatalogRequestSequence;
  memoryReviewsRequestSequence += 1;
  memoryFeature.setReviewCatalogLoading();
  const result = await requestJson(memoryFeature.reviewScopesEndpoint);
  if (requestSequence !== memoryReviewCatalogRequestSequence) {
    return;
  }
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200) {
    memoryFeature.showReviewCatalogError();
    announce('Review scopes unavailable.');
    return;
  }
  const state = memoryFeature.renderReviewCatalog(result.body);
  if (!state) {
    memoryFeature.showReviewCatalogError();
    announce('Review scopes unavailable.');
    return;
  }
  if (state.selected) {
    await loadMemoryReviews(state.selected);
    return;
  }
  announce(state.state === 'empty' ? 'No review scopes.' : 'Select a review scope.');
}

async function loadMemoryReviews(selected) {
  const requestSequence = ++memoryReviewsRequestSequence;
  memoryFeature.setReviewsLoading();
  const result = await requestJson(memoryFeature.reviewsEndpoint, {
    headers: {
      Accept: 'application/json',
      'X-LetheBot-Scope': selected.handle,
    },
  });
  if (requestSequence !== memoryReviewsRequestSequence) {
    return;
  }
  if (result.status === 401) {
    showSessionExpired();
    return;
  }
  if (result.status !== 200) {
    memoryFeature.showReviewsError();
    announce('Memory reviews unavailable.');
    return;
  }
  const state = memoryFeature.renderReviews(result.body, selected.scopeKind);
  if (state === null) {
    memoryFeature.showReviewsError();
    announce('Memory reviews unavailable.');
    return;
  }
  announce(state === 'empty' ? 'No memory reviews.' : 'Memory reviews updated.');
}

async function handleLogin(event) {
  event.preventDefault();
  const token = elements.tokenInput?.value || '';
  if (elements.tokenInput) {
    elements.tokenInput.value = '';
  }
  setHidden(elements.loginError, true);
  if (!token) {
    showLogin('Admin token is required.');
    return;
  }
  if (elements.loginButton) {
    elements.loginButton.disabled = true;
  }
  const login = await requestJson(SESSION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (
    login.status !== 201
    || !login.body
    || typeof login.body.csrfToken !== 'string'
    || !OPAQUE_VALUE_PATTERN.test(login.body.csrfToken)
  ) {
    showLogin(login.status === 401 ? 'Credentials not accepted.' : 'Sign in unavailable.');
    announce('Sign in failed.');
    return;
  }
  csrfToken = login.body.csrfToken;
  const session = await requestJson(SESSION_ENDPOINT);
  if (
    session.status !== 200
    || !session.body
    || session.body.actor !== 'local_admin'
    || typeof session.body.expiresAt !== 'number'
  ) {
    showLogin('Session unavailable.');
    announce('Session unavailable.');
    return;
  }
  showOverview(session.body.expiresAt);
  await loadOverview();
}

async function handleLogout() {
  if (!csrfToken) {
    showLogin('Session expired.');
    return;
  }
  if (elements.logoutButton) {
    elements.logoutButton.disabled = true;
  }
  const result = await requestJson(SESSION_ENDPOINT, {
    method: 'DELETE',
    headers: { 'X-LetheBot-CSRF': csrfToken },
  });
  csrfToken = null;
  if (elements.logoutButton) {
    elements.logoutButton.disabled = false;
  }
  showLogin(result.status === 204 ? '' : 'Session closed locally.');
  announce('Signed out.');
}

function handleActivityTabKeydown(event) {
  const tabs = activityTabs.map(({ tab }) => tab).filter(Boolean);
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) {
    return;
  }

  let nextIndex;
  if (event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1;
  } else {
    return;
  }

  event.preventDefault();
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

function registerActivityTab(view, tab, load) {
  tab?.addEventListener('click', () => {
    selectActivitySubview(view);
    void load();
  });
  tab?.addEventListener('keydown', handleActivityTabKeydown);
}

function handleMemoryTabKeydown(event) {
  const tabs = [memoryFeature.recordsTab, memoryFeature.reviewsTab];
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) {
    return;
  }
  let nextIndex;
  if (event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

elements.loginForm?.addEventListener('submit', (event) => {
  void handleLogin(event);
});
elements.refreshButton?.addEventListener('click', () => {
  void loadOverview();
});
memoryFeature.refreshButton.addEventListener('click', () => {
  if (memoryFeature.selectedSubview() === 'reviews') {
    void loadMemoryReviewCatalog();
  } else {
    void loadMemoryCatalog();
  }
});
memoryFeature.scopeSelect.addEventListener('change', () => {
  memoryRecordsRequestSequence += 1;
  const selected = memoryFeature.selectScope();
  if (selected) {
    void loadMemoryRecords(selected);
  }
});
memoryFeature.reviewScopeSelect.addEventListener('change', () => {
  memoryReviewsRequestSequence += 1;
  const selected = memoryFeature.selectReviewScope();
  if (selected) {
    void loadMemoryReviews(selected);
  }
});
memoryFeature.recordsTab.addEventListener('click', () => {
  selectMemorySubview('records');
  void loadMemoryCatalog();
});
memoryFeature.reviewsTab.addEventListener('click', () => {
  selectMemorySubview('reviews');
  void loadMemoryReviewCatalog();
});
memoryFeature.recordsTab.addEventListener('keydown', handleMemoryTabKeydown);
memoryFeature.reviewsTab.addEventListener('keydown', handleMemoryTabKeydown);
elements.activityRefreshButton?.addEventListener('click', () => {
  void loadActivity();
});
for (const controller of activityListControllers) {
  controller.refreshButton?.addEventListener('click', () => {
    void loadActivityList(controller);
  });
}
elements.logoutButton?.addEventListener('click', () => {
  void handleLogout();
});
elements.overviewNav?.addEventListener('click', () => {
  selectView('overview');
});
memoryFeature.nav.addEventListener('click', () => {
  selectView('memory');
  selectMemorySubview('records');
  void loadMemoryCatalog();
});
explainFeature.nav.addEventListener('click', () => {
  selectView('explain');
  void explainFeature.load();
});
privacyFeature.nav.addEventListener('click', () => {
  selectView('privacy');
  void privacyFeature.load();
});
groupSummaryFeature.nav.addEventListener('click', () => {
  selectView('group-summary');
  void groupSummaryFeature.load();
});
displayProfileFeature.nav.addEventListener('click', () => {
  selectView('display-profile');
  void displayProfileFeature.load();
});
identityFeature.nav.addEventListener('click', () => {
  selectView('identity');
  void identityFeature.load();
});
operationsFeature.nav.addEventListener('click', () => {
  selectView('operations');
  void operationsFeature.load();
});
elements.activityNav?.addEventListener('click', () => {
  selectView('activity');
  selectActivitySubview('models');
  void loadActivity();
});
registerActivityTab('models', elements.modelInvocationsTab, loadActivity);
for (const controller of activityListControllers) {
  registerActivityTab(
    controller.view,
    controller.tab,
    () => loadActivityList(controller),
  );
}

showLogin('');
