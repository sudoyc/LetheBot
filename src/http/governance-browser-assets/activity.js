const BASE = '/governance/api/v1/activity/';
const ACTIVITY_ENDPOINT = BASE + 'model-invocations';
const TOOL_CALLS_ENDPOINT = BASE + 'tool-calls';
const WORKER_HEARTBEATS_ENDPOINT = BASE + 'worker-heartbeats';
const JOBS_ENDPOINT = BASE + 'jobs';
const JOB_ATTEMPTS_ENDPOINT = BASE + 'job-attempts';
const ACTION_DECISIONS_ENDPOINT = BASE + 'action-decisions';
const ACTION_EXECUTIONS_ENDPOINT = BASE + 'action-executions';
const EVENT_PROCESSING_FAILURES_ENDPOINT = BASE + 'event-processing-failures';
const AUDIT_ENDPOINT = BASE + 'audit';
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECORDS = 100;
const MAX_TEXT = 256;
const MAX_DIAGNOSTIC = 512;
const PRIMARY = 'tool-call-primary';
const SECONDARY = 'tool-call-secondary';
const DIAGNOSTIC = 'tool-call-diagnostic';
const activityBucketBindings = [
  ['purpose-summary', 'byPurpose', 'summary'],
  ['purpose-evaluator', 'byPurpose', 'evaluator'],
  ['purpose-pi-turn', 'byPurpose', 'pi_turn'],
  ['status-running', 'byStatus', 'running'],
  ['status-completed', 'byStatus', 'completed'],
  ['status-failed', 'byStatus', 'failed'],
  ['status-aborted', 'byStatus', 'aborted'],
];

const activityPurposeKeys = ['summary', 'evaluator', 'pi_turn'];
const activityStatusKeys = ['running', 'completed', 'failed', 'aborted'];
const activityLatencyKeys = ['count', 'sumMs', 'maxMs'];
const toolCallKeys = [
  'id',
  'turnId',
  'toolName',
  'requestedBy',
  'actor',
  'context',
  'status',
  'errorCode',
  'errorMessage',
  'executionTimeMs',
  'secretsRedacted',
  'createdAt',
];
const toolCallActorKeys = ['canonicalUserId', 'actorClass'];
const toolCallRequesters = ['pi', 'evaluator', 'user', 'system'];
const toolCallActors = [
  'owner',
  'admin',
  'trusted_user',
  'user',
  'group_admin',
  'system_worker',
  'evaluator',
  'tool',
];
const toolCallContexts = [
  'private_chat',
  'group_chat',
  'admin_cli',
  'background_worker',
  'internal',
];
const toolCallStatuses = ['success', 'error', 'timeout', 'rejected'];
const workerHeartbeatKeys = [
  'workerId',
  'workerType',
  'status',
  'currentJobId',
  'heartbeatAt',
];
const workerHeartbeatStatuses = ['idle', 'running', 'stopping', 'error'];
const jobKeys = [
  'id',
  'type',
  'status',
  'attempts',
  'maxAttempts',
  'idempotencyKey',
  'leaseOwner',
  'leaseExpiresAt',
  'heartbeatAt',
  'createdAt',
  'updatedAt',
  'scheduledAt',
  'startedAt',
  'completedAt',
  'error',
];
const jobStatuses = ['pending', 'running', 'completed', 'failed'];
const jobAttemptKeys = [
  'id',
  'jobId',
  'attemptNumber',
  'workerId',
  'status',
  'startedAt',
  'completedAt',
  'heartbeatAt',
  'error',
];
const jobAttemptStatuses = ['running', 'completed', 'failed'];
const actionTypes =
  'silent_store silent_summarize_later reply_short reply_full reply_with_tool propose_memory admin_digest schedule_background_task dm_user react_only send_folded_forward ask_clarification'.split(' ');
export function createActivityFeature(
  elements,
  setText,
  formatGeneratedAt,
  boundedNumber,
) {
const activityListDefinitions = [
  [
    'tools',
    'tool-calls',
    'Tool calls',
    'Latest recorded calls',
    'calls',
    'tool activity',
    'Latest tool calls',
    [
      ['Tool', 'tool-column'],
      ['Actor and context', 'actor-column'],
      ['Outcome', 'outcome-column'],
      ['Duration', 'duration-column'],
      ['Recorded', 'recorded-column'],
    ],
    TOOL_CALLS_ENDPOINT,
    renderToolCalls,
  ],
  [
    'workers',
    'worker-heartbeats',
    'Worker heartbeats',
    'Latest worker signals',
    'workers',
    'worker activity',
    'Latest worker heartbeats',
    [
      ['Worker', 'worker-column'],
      ['Status', 'worker-status-column'],
      ['Current job', 'current-job-column'],
      ['Last heartbeat', 'heartbeat-column'],
    ],
    WORKER_HEARTBEATS_ENDPOINT,
    renderWorkerHeartbeats,
  ],
  [
    'jobs',
    'jobs',
    'Jobs',
    'Scheduled work',
    'jobs',
    'job activity',
    'Scheduled jobs',
    [['Job'], ['State'], ['Schedule and updates'], ['Run lifecycle']],
    JOBS_ENDPOINT,
    renderJobs,
  ],
  [
    'attempts',
    'job-attempts',
    'Job attempts',
    'Execution history',
    'attempts',
    'execution history',
    'Job attempt history',
    [['Job and attempt'], ['Worker'], ['State'], ['Timeline']],
    JOB_ATTEMPTS_ENDPOINT,
    renderJobAttempts,
  ],
  [
    'decisions',
    'action-decisions',
    'Action decisions',
    null,
    'decisions',
    null,
    'Action decision history',
    [['Decision'], ['Actor and risk'], ['Evaluation'], ['Evidence']],
    ACTION_DECISIONS_ENDPOINT,
    renderActionDecisions,
  ],
  [
    'executions',
    'action-executions',
    'Action executions',
    null,
    'executions',
    null,
    'Action execution history',
    [['Execution and decision'], ['Action and status'], ['Effects'], ['Evidence and audit']],
    ACTION_EXECUTIONS_ENDPOINT,
    renderActionExecutions,
  ],
  [
    'failures',
    'event-processing-failures',
    'Event processing failures',
    null,
    'failures',
    null,
    'Event processing failure history',
    [['Failure and time'], ['References'], ['Stage and conversation'], ['Error evidence']],
    EVENT_PROCESSING_FAILURES_ENDPOINT,
    renderEventProcessingFailures,
  ],
  [
    'audit',
    'audit',
    'Audit',
    null,
    'events',
    null,
    'Audit history',
    [['Event and time'], ['Category and level'], ['Actor'], ['Summary and risk']],
    AUDIT_ENDPOINT,
    renderAuditRecords,
  ],
];
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return isRecord(value)
    && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function boundedBucket(value, key) {
  if (!isRecord(value)) {
    return null;
  }
  if (!hasOwn(value, key)) {
    return 0;
  }
  return boundedNumber(value[key]);
}
function renderActivity(summary) {
  if (
    !isRecord(summary)
    || !isRecord(summary.filters)
    || Object.keys(summary.filters).length !== 0
    || !hasOnlyKeys(summary.byPurpose, activityPurposeKeys)
    || !hasOnlyKeys(summary.byStatus, activityStatusKeys)
    || !hasOnlyKeys(summary.providerLatencyMs, activityLatencyKeys)
    || typeof summary.generatedAt !== 'string'
    || summary.generatedAt.length > 64
    || !Number.isFinite(new Date(summary.generatedAt).getTime())
  ) {
    return null;
  }

  const total = boundedNumber(summary.total);
  const knownUsage = boundedNumber(summary.completedKnownUsage);
  const unknownUsage = boundedNumber(summary.completedUnknownUsage);
  const latencyCount = boundedNumber(summary.providerLatencyMs.count);
  const latencySum = boundedNumber(summary.providerLatencyMs.sumMs);
  const latencyMax = boundedNumber(summary.providerLatencyMs.maxMs);
  const buckets = activityBucketBindings.map(([id, group, key]) => ({
    id,
    value: boundedBucket(summary[group], key),
  }));
  if (
    total === null
    || knownUsage === null
    || unknownUsage === null
    || latencyCount === null
    || latencySum === null
    || latencyMax === null
    || buckets.some(({ value }) => value === null)
  ) {
    return null;
  }

  setText(elements.activityTotal, total.toLocaleString());
  setText(elements.activityGeneratedAt, formatGeneratedAt(summary.generatedAt));
  for (const { id, value } of buckets) {
    setText(document.getElementById(id), value.toLocaleString());
  }
  setText(document.getElementById('usage-known'), knownUsage.toLocaleString());
  setText(document.getElementById('usage-unknown'), unknownUsage.toLocaleString());
  setText(document.getElementById('latency-count'), latencyCount.toLocaleString());
  setText(document.getElementById('latency-sum'), latencySum.toLocaleString() + ' ms');
  setText(document.getElementById('latency-max'), latencyMax.toLocaleString() + ' ms');
  return total === 0 ? 'empty' : 'content';
}
function boundedText(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    ? value
    : null;
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedTextFields(record, fields, optional = false) {
  return fields.every(([key, maxLength]) => (
    optional && !hasOwn(record, key)
  ) || boundedText(record[key], maxLength) !== null);
}

function boundedDecisionText(value) {
  return Array.isArray(value)
    && value.length <= 32
    && value.every((item) => boundedText(item, 512) !== null);
}

function dateText(value, exactIso = false) {
  const text = boundedText(value, 64);
  const date = new Date(text);
  return text !== null
    && Number.isFinite(date.getTime())
    && (!exactIso || date.toISOString() === text)
    ? text
    : null;
}

function dateFields(record, fields, optional = false, exactIso = false) {
  return fields.every((key) => (
    optional && !hasOwn(record, key)
  ) || dateText(record[key], exactIso) !== null);
}

function activityValueLabel(value) {
  return value === 'admin_cli'
    ? 'Admin CLI'
    : value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ');
}

function normalizeToolCallRecord(value) {
  if (
    !hasOnlyKeys(value, toolCallKeys)
    || !hasOnlyKeys(value.actor, toolCallActorKeys)
    || !boundedTextFields(value, [
      ['id', MAX_TEXT],
      ['turnId', MAX_TEXT],
      ['toolName', MAX_TEXT],
    ])
    || !boundedTextFields(value.actor, [
      ['canonicalUserId', MAX_TEXT],
    ], true)
    || !boundedTextFields(value, [
      ['errorCode', MAX_TEXT],
      ['errorMessage', MAX_DIAGNOSTIC],
    ], true)
    || !dateFields(value, ['createdAt'])
    || !toolCallRequesters.includes(value.requestedBy)
    || !toolCallActors.includes(value.actor.actorClass)
    || !toolCallContexts.includes(value.context)
    || !toolCallStatuses.includes(value.status)
    || typeof value.secretsRedacted !== 'boolean'
    || (hasOwn(value, 'executionTimeMs')
      && (!Number.isSafeInteger(value.executionTimeMs) || value.executionTimeMs < 0))
  ) {
    return null;
  }

  return {
    toolName: value.toolName,
    requestedBy: value.requestedBy,
    actorClass: value.actor.actorClass,
    context: value.context,
    status: value.status,
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
    executionTimeMs: value.executionTimeMs,
    secretsRedacted: value.secretsRedacted,
    createdAt: value.createdAt,
  };
}

function appendActivityRecordLines(parent, lines) {
  for (const [className, value] of lines) {
    if (value !== undefined) {
      const line = document.createElement('span');
      line.className = className;
      line.textContent = value;
      parent.append(line);
    }
  }
}

function createActivityRecordCell(label, lines = [], statusValue) {
  const cell = document.createElement('td');
  cell.dataset.label = label;
  if (statusValue) {
    const [className, value] = statusValue;
    const status = document.createElement('span');
    status.className = className + ' ' + className + '-' + value;
    status.textContent = activityValueLabel(value);
    cell.append(status);
  }
  appendActivityRecordLines(cell, lines);
  return cell;
}

function createActivityRecordRow(cells) {
  const row = document.createElement('tr');
  row.append(...cells.map((cell) => createActivityRecordCell(...cell)));
  return row;
}

function formatActivityRecordTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatLabeledActivityRecordTime(label, value) {
  return value === undefined
    ? undefined
    : label + ': ' + formatActivityRecordTime(value);
}

function createToolCallRow(record) {
  const diagnostic = record.errorCode && record.errorMessage
    ? record.errorCode + ': ' + record.errorMessage
    : record.errorCode || record.errorMessage;
  return createActivityRecordRow([
    ['Tool', [
      [PRIMARY, record.toolName],
      [SECONDARY, 'Requested by ' + activityValueLabel(record.requestedBy)],
    ]],
    ['Actor and context', [
      [PRIMARY, activityValueLabel(record.actorClass)],
      [SECONDARY, activityValueLabel(record.context)],
    ]],
    ['Outcome', [
      [DIAGNOSTIC, diagnostic],
      [
        'tool-call-redaction',
        record.secretsRedacted ? 'Sensitive fields redacted' : undefined,
      ],
    ], ['tool-call-status', record.status]],
    ['Duration', [[
      PRIMARY + ' tool-call-number',
      record.executionTimeMs === undefined
        ? 'Unavailable'
        : record.executionTimeMs.toLocaleString() + ' ms',
    ]]],
    ['Recorded', [[
      PRIMARY + ' tool-call-number',
      formatActivityRecordTime(record.createdAt),
    ]]],
  ]);
}

function renderActivityRecords(value, controller, maxRecords, normalize, createRow, nouns) {
  if (
    !Array.isArray(value)
    || value.length > maxRecords
    || !controller.list
  ) {
    return null;
  }
  const records = Array.from(value, normalize);
  if (records.includes(null)) {
    return null;
  }
  controller.list.replaceChildren(...records.map(createRow));
  setText(
    controller.count,
    'Showing ' + records.length.toLocaleString()
      + ' ' + nouns[records.length === 1 ? 0 : 1],
  );
  return records.length === 0 ? 'empty' : 'content';
}

function renderToolCalls(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    MAX_RECORDS,
    normalizeToolCallRecord,
    createToolCallRow,
    ['call', 'calls'],
  );
}

function normalizeWorkerHeartbeatRecord(value) {
  if (
    !hasOnlyKeys(value, workerHeartbeatKeys)
    || !boundedTextFields(value, [
      ['workerId', MAX_TEXT],
      ['workerType', MAX_TEXT],
    ])
    || !boundedTextFields(value, [
      ['currentJobId', MAX_TEXT],
    ], true)
    || !workerHeartbeatStatuses.includes(value.status)
    || !dateFields(value, ['heartbeatAt'], false, true)
  ) {
    return null;
  }

  return {
    workerId: value.workerId,
    workerType: value.workerType,
    status: value.status,
    currentJobId: value.currentJobId,
    heartbeatAt: value.heartbeatAt,
  };
}

function createWorkerHeartbeatRow(record) {
  return createActivityRecordRow([
    ['Worker', [
      ['worker-heartbeat-primary', record.workerId],
      ['worker-heartbeat-secondary', record.workerType],
    ]],
    ['Status', [], ['worker-heartbeat-status', record.status]],
    ['Current job', [[
      'worker-heartbeat-primary',
      record.currentJobId === undefined ? 'None' : record.currentJobId,
    ]]],
    ['Last heartbeat', [[
      'worker-heartbeat-primary worker-heartbeat-number',
      formatActivityRecordTime(record.heartbeatAt),
    ]]],
  ]);
}

function renderWorkerHeartbeats(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    MAX_RECORDS,
    normalizeWorkerHeartbeatRecord,
    createWorkerHeartbeatRow,
    ['worker', 'workers'],
  );
}

function normalizeJobRecord(value) {
  if (
    !hasOnlyKeys(value, jobKeys)
    || !boundedTextFields(value, [
      ['id', MAX_TEXT],
      ['type', MAX_TEXT],
    ])
    || !boundedTextFields(value, [
      ['idempotencyKey', MAX_TEXT],
      ['leaseOwner', MAX_TEXT],
      ['error', MAX_DIAGNOSTIC],
    ], true)
    || !dateFields(value, ['createdAt', 'updatedAt', 'scheduledAt'], false, true)
    || !dateFields(
      value,
      ['leaseExpiresAt', 'heartbeatAt', 'startedAt', 'completedAt'],
      true,
      true,
    )
    || !jobStatuses.includes(value.status)
    || ![value.attempts, value.maxAttempts].every(Number.isSafeInteger)
    || value.attempts < 0
    || value.maxAttempts < 1
    || value.attempts > value.maxAttempts
  ) {
    return null;
  }
  return value;
}

function createJobRow(record) {
  return createActivityRecordRow([
    ['Job', [
      [PRIMARY, record.id],
      [SECONDARY, record.type],
    ]],
    ['State', [
      [
        SECONDARY + ' tool-call-number',
        record.attempts.toLocaleString()
          + ' / ' + record.maxAttempts.toLocaleString() + ' attempts',
      ],
      [DIAGNOSTIC, record.error],
    ], ['job-status', record.status]],
    ['Schedule and updates', [
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Scheduled', record.scheduledAt),
      ],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Updated', record.updatedAt),
      ],
    ]],
    ['Run lifecycle', [
      [SECONDARY, 'Lease owner: ' + (record.leaseOwner ?? 'unavailable')],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Lease expires', record.leaseExpiresAt),
      ],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Heartbeat', record.heartbeatAt),
      ],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Started', record.startedAt),
      ],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Completed', record.completedAt),
      ],
    ]],
  ]);
}

function renderJobs(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    MAX_RECORDS,
    normalizeJobRecord,
    createJobRow,
    ['job', 'jobs'],
  );
}

function normalizeJobAttemptRecord(value) {
  if (
    !hasOnlyKeys(value, jobAttemptKeys)
    || !boundedTextFields(value, [
      ['id', MAX_TEXT],
      ['jobId', MAX_TEXT],
      ['workerId', MAX_TEXT],
    ])
    || !boundedTextFields(value, [['error', MAX_DIAGNOSTIC]], true)
    || !dateFields(value, ['startedAt'], false, true)
    || !dateFields(value, ['completedAt', 'heartbeatAt'], true, true)
    || !jobAttemptStatuses.includes(value.status)
    || !Number.isSafeInteger(value.attemptNumber)
    || value.attemptNumber < 1
  ) {
    return null;
  }
  return {
    jobId: value.jobId,
    attemptNumber: value.attemptNumber,
    workerId: value.workerId,
    status: value.status,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    heartbeatAt: value.heartbeatAt,
    error: value.error,
  };
}

function createJobAttemptRow(record) {
  return createActivityRecordRow([
    ['Job and attempt', [
      [PRIMARY, record.jobId],
      [
        SECONDARY + ' tool-call-number',
        'Attempt ' + record.attemptNumber.toLocaleString(),
      ],
    ]],
    ['Worker', [[PRIMARY, record.workerId]]],
    ['State', [[DIAGNOSTIC, record.error]], ['job-status', record.status]],
    ['Timeline', [
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Started', record.startedAt),
      ],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Heartbeat', record.heartbeatAt),
      ],
      [
        SECONDARY,
        formatLabeledActivityRecordTime('Completed', record.completedAt),
      ],
    ]],
  ]);
}

function renderJobAttempts(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    MAX_RECORDS,
    normalizeJobAttemptRecord,
    createJobAttemptRow,
    ['attempt', 'attempts'],
  );
}

function normalizeActionDecisionRecord(value) {
  if (
    !hasOnlyKeys(
      value,
      'id turnId createdAt decidedBy riskLevel confidence evaluatorRequired evaluatorPassed actionCount reasons suppressors'.split(' '),
    )
    || !boundedTextFields(value, [
      ['id', 256],
      ['turnId', 256],
    ])
    || !dateFields(value, ['createdAt'], false, true)
    || !['attention', 'pi', 'evaluator'].includes(value.decidedBy)
    || !['low', 'medium', 'high', 'prohibited'].includes(value.riskLevel)
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
    || typeof value.evaluatorRequired !== 'boolean'
    || (hasOwn(value, 'evaluatorPassed') && typeof value.evaluatorPassed !== 'boolean')
    || !Number.isSafeInteger(value.actionCount)
    || value.actionCount < 0
    || ![value.reasons, value.suppressors].every(boundedDecisionText)
  ) {
    return null;
  }
  const { turnId, ...record } = value;
  return record;
}

function createActionDecisionRow(record) {
  const evaluator = record.evaluatorRequired
    ? record.evaluatorPassed === undefined
      ? 'Pending'
      : record.evaluatorPassed ? 'Passed' : 'Rejected'
    : 'Not required';
  const evidence = (label, values) => label + ': ' + (values.join('; ') || 'None');
  return createActivityRecordRow([
    ['Decision', [
      [PRIMARY, record.id],
      [SECONDARY, formatActivityRecordTime(record.createdAt)],
    ]],
    ['Actor and risk', [[
      PRIMARY,
      activityValueLabel(record.decidedBy) + '; ' + record.riskLevel + ' risk',
    ]]],
    ['Evaluation', [[
      PRIMARY,
      evaluator + '; confidence ' + (Math.round(record.confidence * 1000) / 10) + '%',
    ]]],
    ['Evidence', [
      [
        PRIMARY,
        'Actions: ' + record.actionCount.toLocaleString(),
      ],
      [SECONDARY, evidence('Reasons', record.reasons)],
      [SECONDARY, evidence('Suppressors', record.suppressors)],
    ]],
  ]);
}

function renderActionDecisions(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    100,
    normalizeActionDecisionRecord,
    createActionDecisionRow,
    ['decision', 'decisions'],
  );
}

function normalizeActionExecutionRecord(value) {
  if (
    !hasOnlyKeys(
      value,
      'id actionDecisionId actionType status executedMessageId executedMemoryId executedJobId downgradedFrom downgradedReason errorCode errorMessage auditLevel executedAt'.split(' '),
    )
    || !boundedTextFields(value, [
      ['id', 256],
      ['actionDecisionId', 256],
    ])
    || !boundedTextFields(value, [
      ['executedMessageId', 256],
      ['executedMemoryId', 256],
      ['executedJobId', 256],
    ], true)
    || !boundedTextFields(value, [
      ['downgradedReason', 512],
      ['errorCode', 512],
      ['errorMessage', 512],
    ], true)
    || !actionTypes.includes(value.actionType)
    || (hasOwn(value, 'downgradedFrom') && !actionTypes.includes(value.downgradedFrom))
    || !['success', 'downgraded', 'failed', 'rejected'].includes(value.status)
    || !['summary', 'redacted_full', 'full'].includes(value.auditLevel)
    || !dateFields(value, ['executedAt'], false, true)
  ) {
    return null;
  }
  return value;
}

function createActionExecutionRow(record) {
  const diagnostic = record.errorCode && record.errorMessage
    ? record.errorCode + ': ' + record.errorMessage
    : record.errorCode || record.errorMessage;
  return createActivityRecordRow([
    ['Execution and decision', [
      [PRIMARY, record.id],
      [SECONDARY, 'Decision: ' + record.actionDecisionId],
      [SECONDARY, formatActivityRecordTime(record.executedAt)],
    ]],
    ['Action and status', [[
      PRIMARY,
      activityValueLabel(record.actionType),
    ]], ['tool-call-status', record.status]],
    ['Effects', [
      [SECONDARY, 'Message: ' + (record.executedMessageId ?? 'None')],
      [SECONDARY, 'Memory: ' + (record.executedMemoryId ?? 'None')],
      [SECONDARY, 'Job: ' + (record.executedJobId ?? 'None')],
    ]],
    ['Evidence and audit', [
      [
        SECONDARY,
        record.downgradedFrom === undefined
          ? undefined
          : 'Downgraded from: ' + activityValueLabel(record.downgradedFrom),
      ],
      [DIAGNOSTIC, record.downgradedReason],
      [DIAGNOSTIC, diagnostic],
      [PRIMARY, 'Audit: ' + activityValueLabel(record.auditLevel)],
    ]],
  ]);
}

function renderActionExecutions(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    100,
    normalizeActionExecutionRecord,
    createActionExecutionRow,
    ['execution', 'executions'],
  );
}

function normalizeEventProcessingFailureRecord(value) {
  if (
    !hasOnlyKeys(
      value,
      'id rawEventId turnId occurredAt stage conversationType errorName errorMessageHash messageIdHash senderIdHash conversationIdHash'.split(' '),
    )
    || !boundedTextFields(value, [
      ['id', 256],
      ['stage', 256],
      ['errorName', 512],
    ])
    || !boundedTextFields(value, [
      ['rawEventId', 256],
      ['turnId', 256],
    ], true)
    || !dateFields(value, ['occurredAt'], false, true)
    || !HASH_PATTERN.test(value.errorMessageHash)
    || ['messageIdHash', 'senderIdHash', 'conversationIdHash'].some(
      (key) => hasOwn(value, key) && !HASH_PATTERN.test(value[key]),
    )
    || (hasOwn(value, 'conversationType')
      && !['private', 'group'].includes(value.conversationType))
  ) {
    return null;
  }
  return value;
}

function createEventProcessingFailureRow(record) {
  const line = (label, value) => [
    SECONDARY,
    value === undefined ? undefined : label + ': ' + value,
  ];
  return createActivityRecordRow([
    ['Failure and time', [
      [PRIMARY, record.id],
      [SECONDARY, formatActivityRecordTime(record.occurredAt)],
    ]],
    ['References', [
      line('Raw event', record.rawEventId),
      line('Turn', record['turnId']),
    ]],
    ['Stage and conversation', [
      [PRIMARY, record.stage],
      line('Conversation', record.conversationType),
    ]],
    ['Error evidence', [
      [DIAGNOSTIC, record.errorName],
      line('Error hash', record.errorMessageHash),
      line('Message ID hash', record.messageIdHash),
      line('Sender ID hash', record.senderIdHash),
      line('Conversation ID hash', record.conversationIdHash),
    ]],
  ]);
}

function renderEventProcessingFailures(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    100,
    normalizeEventProcessingFailureRecord,
    createEventProcessingFailureRow,
    ['failure', 'failures'],
  );
}

function normalizeAuditRecord(value) {
  if (
    !hasOnlyKeys(
      value,
      'id timestamp category level eventType eventId actor summary detailsRedacted redacted riskLevel evaluatorDecisionId'.split(' '),
    )
    || !hasOnlyKeys(value.actor, ['canonicalUserId', 'actorClass', 'context'])
    || !boundedTextFields(value, [
      ['id', 256],
      ['category', 256],
      ['level', 256],
      ['eventType', 256],
      ['eventId', 256],
      ['summary', 512],
    ])
    || !boundedTextFields(value.actor, [
      ['canonicalUserId', 256],
      ['actorClass', 256],
      ['context', 256],
    ], true)
    || !boundedTextFields(value, [
      ['riskLevel', 256],
      ['evaluatorDecisionId', 256],
    ], true)
    || !dateFields(value, ['timestamp'], false, true)
    || typeof value.detailsRedacted !== 'boolean'
    || typeof value.redacted !== 'boolean'
  ) {
    return null;
  }
  return value;
}

function createAuditRow(record) {
  const line = (label, value) => [
    SECONDARY,
    value === undefined ? undefined : label + ': ' + value,
  ];
  return createActivityRecordRow([
    ['Event and time', [
      [PRIMARY, record.id],
      [SECONDARY, record.eventType],
      line('Event', record.eventId),
      [SECONDARY, formatActivityRecordTime(record.timestamp)],
    ]],
    ['Category and level', [
      [PRIMARY, record.category],
      [SECONDARY, record.level],
    ]],
    ['Actor', [
      line('User', record.actor.canonicalUserId),
      line('Class', record.actor.actorClass),
      line('Context', record.actor.context),
    ]],
    ['Summary and risk', [
      [DIAGNOSTIC, record.summary],
      line('Risk', record.riskLevel),
      line('Evaluator', record.evaluatorDecisionId),
      [SECONDARY, record.detailsRedacted ? 'Details hidden' : 'Details redaction not indicated'],
      [SECONDARY, record.redacted ? 'Redacted' : 'No redaction indicated'],
    ]],
  ]);
}

function renderAuditRecords(value, controller) {
  return renderActivityRecords(
    value,
    controller,
    MAX_RECORDS,
    normalizeAuditRecord,
    createAuditRow,
    ['event', 'events'],
  );
}
return [
  ACTIVITY_ENDPOINT,
  activityListDefinitions,
  renderActivity,
];
}