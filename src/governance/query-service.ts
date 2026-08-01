import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { collectModelInvocationLatency } from '../operations/sqlite-maintenance.js';
import { AuditRepository } from '../storage/audit-repository.js';
import {
  MemoryMaintenanceProposalRepository,
  type MemoryMaintenanceProposalExactScope,
  type MemoryMaintenanceProposalLifecycleState,
  type MemoryMaintenanceProposalRecord,
} from '../storage/memory-maintenance-proposal-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { ContextTraceRepository } from '../storage/context-trace-repository.js';
import {
  PrivacyPreferenceRepository,
  type PrivacyPreferenceState,
  type PrivacyPreferenceType,
} from '../storage/privacy-preference-repository.js';
import type {
  ActionDecision,
  ActionExecutionResult,
  ActionType,
} from '../types/action.js';
import type { MemoryRecord, MemoryRevision, MemorySource } from '../types/memory.js';
import type { ToolCallResult } from '../types/tool.js';
import {
  DISPLAY_PROFILE_REDACTION_ACTION,
  GROUP_SUMMARY_POLICY_CHANGE_ACTION,
  MEMORY_MAINTENANCE_APPLICATION_ACTION,
  MEMORY_MAINTENANCE_APPROVAL_ACTION,
  MEMORY_MAINTENANCE_EXPIRATION_ACTION,
  MEMORY_MAINTENANCE_REJECTION_ACTION,
  MEMORY_MAINTENANCE_ROLLBACK_ACTION,
  MEMORY_PROVENANCE_ACTOR_CLASSES,
  MEMORY_RECORD_FORGET_ACTION,
  MEMORY_RECORD_RESTORE_ACTION,
  PLATFORM_ACCOUNT_UNLINK_ACTION,
  PRIVACY_PREFERENCE_CHANGE_ACTION,
} from './query-contracts.js';
import type {
  ActionDecisionExplanation,
  ActionDecisionInspectionRecord,
  ActionExecutionExplanation,
  ActionExecutionInspectionRecord,
  AuditInspectionRecord,
  DisplayProfileDisplayValueInspectionRecord,
  DisplayProfileHistoryLifecycle,
  DisplayProfileNicknameHistoryDetailInspectionRecord,
  DisplayProfileRedactionSnapshot,
  DisplayProfileScope,
  DisplayProfileScopeHandleCatalog,
  DisplayProfileScopeHandleCatalogEntry,
  DisplayProfileScopeHandleIssuer,
  DisplayProfileTargetDetailInspectionRecord,
  DisplayProfileTargetInspectionPage,
  DisplayProfileTargetInspectionRecord,
  DisplayProfileTargetKind,
  DisplayProfileTargetRedactionMutationSelection,
  DisplayProfileTargetRedactionPreviewProjection,
  DisplayProfileTargetResourceHandleInspectionRecord,
  DisplayProfileTargetResourceHandleIssuer,
  DisplayProfileTargetResourceHandlePage,
  DisplayProfileTrust,
  EventProcessingFailureInspectionRecord,
  ExplainConversationScope,
  ExplainConversationScopeHandleCatalog,
  ExplainConversationScopeHandleCatalogEntry,
  ExplainConversationScopeHandleIssuer,
  ExplainTurnActionDecisionDetailInspectionRecord,
  ExplainTurnContextDetailInspectionRecord,
  ExplainTurnDetailActionType,
  ExplainTurnDetailExecutionEffect,
  ExplainTurnDetailInspectionRecord,
  ExplainTurnDetailLabelInspectionRecord,
  ExplainTurnDetailTokenBudgetInspectionRecord,
  ExplainTurnExecutionDetailInspectionRecord,
  ExplainTurnResolution,
  ExplainTurnResourceHandleInspectionRecord,
  ExplainTurnResourceHandleIssuer,
  ExplainTurnResourceHandlePage,
  ExplainTurnScopeInspectionPage,
  ExplainTurnScopeInspectionRecord,
  ExplainTurnStatus,
  ExplainTurnToolDetailInspectionRecord,
  ExportMemoryRecord,
  GovernanceHealthSummaryInspectionRecord,
  GovernanceQueryScope,
  GroupSummaryPolicyChangePreviewProjection,
  GroupSummaryPolicyScope,
  GroupSummaryPolicyScopeHandleCatalog,
  GroupSummaryPolicyScopeHandleCatalogEntry,
  GroupSummaryPolicyScopeHandleIssuer,
  GroupSummaryPolicyScopeInspection,
  JobAttemptInspectionRecord,
  JobInspectionRecord,
  ListActionDecisionOptions,
  ListActionExecutionOptions,
  ListAuditOptions,
  ListEventProcessingFailureOptions,
  ListJobAttemptOptions,
  ListJobOptions,
  ListMemoryMaintenanceReviewsOptions,
  ListMemoryOptions,
  ListMemoryReviewOptions,
  ListPrivacyPreferenceOptions,
  ListToolCallOptions,
  ListWorkerHeartbeatOptions,
  MemoryMaintenanceApplicationConfirmationProjection,
  MemoryMaintenanceApplicationPreviewProjection,
  MemoryMaintenanceApprovalConfirmationProjection,
  MemoryMaintenanceApprovalPreviewProjection,
  MemoryMaintenanceExpirationConfirmationProjection,
  MemoryMaintenanceExpirationPreviewProjection,
  MemoryMaintenanceRejectionConfirmationProjection,
  MemoryMaintenanceRejectionPreviewProjection,
  MemoryMaintenanceReviewDetailInspectionRecord,
  MemoryMaintenanceReviewInspectionRecord,
  MemoryMaintenanceReviewListPage,
  MemoryMaintenanceReviewResourceHandleInspectionRecord,
  MemoryMaintenanceReviewResourceHandleIssuer,
  MemoryMaintenanceReviewResourceHandlePage,
  MemoryMaintenanceReviewScopeCatalog,
  MemoryMaintenanceReviewScopeCatalogEntry,
  MemoryMaintenanceReviewScopeHandleCatalog,
  MemoryMaintenanceReviewScopeHandleCatalogEntry,
  MemoryMaintenanceReviewScopeHandleIssuer,
  MemoryMaintenanceRollbackConfirmationProjection,
  MemoryMaintenanceRollbackPreviewProjection,
  MemoryRecordAuditDetailInspectionRecord,
  MemoryRecordDetailInspectionRecord,
  MemoryRecordForgetPreviewProjection,
  MemoryRecordInspectionRecord,
  MemoryRecordProvenanceActorClass,
  MemoryRecordResourceHandleInspectionRecord,
  MemoryRecordResourceHandleIssuer,
  MemoryRecordResourceHandlePage,
  MemoryRecordRestorePreviewProjection,
  MemoryRecordRevisionDetailInspectionRecord,
  MemoryRecordScopeHandleCatalog,
  MemoryRecordScopeHandleCatalogEntry,
  MemoryRecordScopeHandleIssuer,
  MemoryRecordScopeInspectionPage,
  MemoryRecordScopeInspectionRecord,
  MemoryRecordSourceDetailInspectionRecord,
  MemorySourceInspectionRecord,
  MemoryReviewAuditEventType,
  MemoryReviewCandidateInspectionRecord,
  MemoryReviewResolutionStatus,
  MemoryReviewSummaryEventTypeRecord,
  MemoryReviewSummaryInspectionRecord,
  MemoryReviewSummaryOptions,
  ModelInvocationPurpose,
  ModelInvocationStatus,
  ModelInvocationSummaryInspectionRecord,
  PlatformAccountUnlinkPreviewProjection,
  PlatformAccountUnlinkSnapshot,
  PrivacyPreferenceChangePreviewProjection,
  PrivacyPreferenceInspectionRecord,
  PrivacyPreferenceScope,
  PrivacyPreferenceScopeHandleCatalog,
  PrivacyPreferenceScopeHandleCatalogEntry,
  PrivacyPreferenceScopeHandleIssuer,
  PrivacyPreferenceScopeInspectionPage,
  PrivacyPreferenceScopeInspectionRecord,
  ResolvedMemoryMaintenanceApplication,
  RestorableMemoryRecordState,
  ShowMemoryResult,
  StoredContextExplanation,
  SummarizeModelInvocationsOptions,
  ToolCallExplanation,
  ToolCallInspectionRecord,
  WorkerHeartbeatInspectionRecord,
} from './query-contracts.js';
import {
  collectGovernanceMemoryIdGroups,
  describeGovernanceActionExecutionEffect,
  parseGovernanceJson,
  projectBoundedGovernanceText,
  projectGovernanceActionDecisionExplanation,
  projectGovernanceActionDecisionInspection,
  projectGovernanceActionExecutionExplanation,
  projectGovernanceActionExecutionInspection,
  projectGovernanceEventProcessingFailureInspection,
  projectGovernanceExplainTurnResolution,
  projectGovernanceJobAttemptInspection,
  projectGovernanceJobInspection,
  projectGovernanceMemoryExport,
  projectGovernancePrivacyPreferenceInspection,
  projectGovernancePrivacyPreferenceScopeInspection,
  projectGovernanceStoredContextExplanation,
  projectGovernanceToolCallExplanation,
  projectGovernanceToolCallInspection,
  projectGovernanceWorkerHeartbeatInspection,
  redactGovernanceDisplayString,
  redactGovernanceMemoryRecordForDisplay,
  redactGovernanceStringArray,
  redactGovernanceStructuredValue,
  sameMemoryMaintenanceExactScope,
} from './query-projections.js';
import type {
  ActionDecisionRow,
  ActionExecutionRow,
  EventProcessingFailureRow,
  ExplainTurnResolutionRow,
  JobAttemptRow,
  JobRow,
  ToolCallRow,
  WorkerHeartbeatRow,
} from './query-projections.js';

export {
  collectGovernanceMemoryIdGroups,
  projectGovernanceActionDecisionExplanation,
  projectGovernanceActionDecisionInspection,
  projectGovernanceActionExecutionExplanation,
  projectGovernanceActionExecutionInspection,
  projectGovernanceEventProcessingFailureInspection,
  projectGovernanceExplainTurnResolution,
  projectGovernanceJobAttemptInspection,
  projectGovernanceJobInspection,
  projectGovernanceMemoryExport,
  projectGovernancePrivacyPreferenceInspection,
  projectGovernancePrivacyPreferenceScopeInspection,
  projectGovernanceStoredContextExplanation,
  projectGovernanceToolCallExplanation,
  projectGovernanceToolCallInspection,
  projectGovernanceWorkerHeartbeatInspection,
  redactGovernanceDisplayString,
  redactGovernanceMemoryRecordForDisplay,
  redactGovernanceStructuredValue,
};

export {
  DISPLAY_PROFILE_REDACTION_ACTION,
  GROUP_SUMMARY_POLICY_CHANGE_ACTION,
  MEMORY_MAINTENANCE_APPLICATION_ACTION,
  MEMORY_MAINTENANCE_APPROVAL_ACTION,
  MEMORY_MAINTENANCE_EXPIRATION_ACTION,
  MEMORY_MAINTENANCE_REJECTION_ACTION,
  MEMORY_MAINTENANCE_ROLLBACK_ACTION,
  MEMORY_RECORD_FORGET_ACTION,
  MEMORY_RECORD_RESTORE_ACTION,
  PLATFORM_ACCOUNT_UNLINK_ACTION,
  PRIVACY_PREFERENCE_CHANGE_ACTION,
};

export type {
  ActionDecisionExplanation,
  ActionDecisionInspectionRecord,
  ActionExecutionExplanation,
  ActionExecutionInspectionRecord,
  AuditInspectionRecord,
  DisplayProfileDisplayValueInspectionRecord,
  DisplayProfileHistoryLifecycle,
  DisplayProfileNicknameHistoryDetailInspectionRecord,
  DisplayProfileRedactionSnapshot,
  DisplayProfileScope,
  DisplayProfileScopeHandleCatalog,
  DisplayProfileScopeHandleCatalogEntry,
  DisplayProfileScopeHandleIssuer,
  DisplayProfileTargetDetailInspectionRecord,
  DisplayProfileTargetInspectionPage,
  DisplayProfileTargetInspectionRecord,
  DisplayProfileTargetKind,
  DisplayProfileTargetRedactionMutationSelection,
  DisplayProfileTargetRedactionPreviewProjection,
  DisplayProfileTargetResourceHandleInspectionRecord,
  DisplayProfileTargetResourceHandleIssuer,
  DisplayProfileTargetResourceHandlePage,
  DisplayProfileTrust,
  EventProcessingFailureInspectionRecord,
  ExplainConversationScope,
  ExplainConversationScopeHandleCatalog,
  ExplainConversationScopeHandleCatalogEntry,
  ExplainConversationScopeHandleIssuer,
  ExplainTurnActionDecisionDetailInspectionRecord,
  ExplainTurnContextDetailInspectionRecord,
  ExplainTurnDetailActionType,
  ExplainTurnDetailExecutionEffect,
  ExplainTurnDetailInspectionRecord,
  ExplainTurnDetailLabelInspectionRecord,
  ExplainTurnDetailTokenBudgetInspectionRecord,
  ExplainTurnExecutionDetailInspectionRecord,
  ExplainTurnResolution,
  ExplainTurnResourceHandleInspectionRecord,
  ExplainTurnResourceHandleIssuer,
  ExplainTurnResourceHandlePage,
  ExplainTurnScopeInspectionPage,
  ExplainTurnScopeInspectionRecord,
  ExplainTurnStatus,
  ExplainTurnToolDetailInspectionRecord,
  ExportMemoryRecord,
  GovernanceHealthSummaryInspectionRecord,
  GovernanceQueryScope,
  GroupSummaryPolicyChangePreviewProjection,
  GroupSummaryPolicyScope,
  GroupSummaryPolicyScopeHandleCatalog,
  GroupSummaryPolicyScopeHandleCatalogEntry,
  GroupSummaryPolicyScopeHandleIssuer,
  GroupSummaryPolicyScopeInspection,
  JobAttemptInspectionRecord,
  JobInspectionRecord,
  ListActionDecisionOptions,
  ListActionExecutionOptions,
  ListAuditOptions,
  ListEventProcessingFailureOptions,
  ListJobAttemptOptions,
  ListJobOptions,
  ListMemoryMaintenanceReviewsOptions,
  ListMemoryOptions,
  ListMemoryReviewOptions,
  ListPrivacyPreferenceOptions,
  ListToolCallOptions,
  ListWorkerHeartbeatOptions,
  MemoryMaintenanceApplicationConfirmationProjection,
  MemoryMaintenanceApplicationPreviewProjection,
  MemoryMaintenanceApprovalConfirmationProjection,
  MemoryMaintenanceApprovalPreviewProjection,
  MemoryMaintenanceExpirationConfirmationProjection,
  MemoryMaintenanceExpirationPreviewProjection,
  MemoryMaintenanceRejectionConfirmationProjection,
  MemoryMaintenanceRejectionPreviewProjection,
  MemoryMaintenanceReviewDetailInspectionRecord,
  MemoryMaintenanceReviewInspectionRecord,
  MemoryMaintenanceReviewListPage,
  MemoryMaintenanceReviewResourceHandleInspectionRecord,
  MemoryMaintenanceReviewResourceHandleIssuer,
  MemoryMaintenanceReviewResourceHandlePage,
  MemoryMaintenanceReviewScopeCatalog,
  MemoryMaintenanceReviewScopeCatalogEntry,
  MemoryMaintenanceReviewScopeHandleCatalog,
  MemoryMaintenanceReviewScopeHandleCatalogEntry,
  MemoryMaintenanceReviewScopeHandleIssuer,
  MemoryMaintenanceRollbackConfirmationProjection,
  MemoryMaintenanceRollbackPreviewProjection,
  MemoryRecordAuditDetailInspectionRecord,
  MemoryRecordDetailInspectionRecord,
  MemoryRecordForgetPreviewProjection,
  MemoryRecordInspectionRecord,
  MemoryRecordProvenanceActorClass,
  MemoryRecordResourceHandleInspectionRecord,
  MemoryRecordResourceHandleIssuer,
  MemoryRecordResourceHandlePage,
  MemoryRecordRestorePreviewProjection,
  MemoryRecordRevisionDetailInspectionRecord,
  MemoryRecordScopeHandleCatalog,
  MemoryRecordScopeHandleCatalogEntry,
  MemoryRecordScopeHandleIssuer,
  MemoryRecordScopeInspectionPage,
  MemoryRecordScopeInspectionRecord,
  MemoryRecordSourceDetailInspectionRecord,
  MemorySourceInspectionRecord,
  MemoryReviewAuditEventType,
  MemoryReviewCandidateInspectionRecord,
  MemoryReviewResolutionStatus,
  MemoryReviewSummaryEventTypeRecord,
  MemoryReviewSummaryInspectionRecord,
  MemoryReviewSummaryOptions,
  ModelInvocationPurpose,
  ModelInvocationStatus,
  ModelInvocationSummaryInspectionRecord,
  PlatformAccountUnlinkPreviewProjection,
  PlatformAccountUnlinkSnapshot,
  PrivacyPreferenceChangePreviewProjection,
  PrivacyPreferenceInspectionRecord,
  PrivacyPreferenceScope,
  PrivacyPreferenceScopeHandleCatalog,
  PrivacyPreferenceScopeHandleCatalogEntry,
  PrivacyPreferenceScopeHandleIssuer,
  PrivacyPreferenceScopeInspectionPage,
  PrivacyPreferenceScopeInspectionRecord,
  ResolvedMemoryMaintenanceApplication,
  ShowMemoryResult,
  StoredContextExplanation,
  SummarizeModelInvocationsOptions,
  ToolCallExplanation,
  ToolCallInspectionRecord,
  WorkerHeartbeatInspectionRecord,
};

const MAX_MEMORY_MAINTENANCE_DETAIL_ITEMS = 32;
const MAX_MEMORY_MAINTENANCE_REVIEW_ENTRIES = 100;
const MAX_MEMORY_MAINTENANCE_SCOPE_CATALOG_ENTRIES = 100;
const MAX_MEMORY_RECORD_SCOPE_CATALOG_ENTRIES = 100;
const MAX_MEMORY_RECORD_PAGE_ENTRIES = 100;
const MAX_MEMORY_RECORD_DETAIL_ITEMS = 32;
const MAX_MEMORY_RECORD_TITLE_CODE_POINTS = 160;
const MAX_MEMORY_RECORD_CONTENT_CODE_POINTS = 512;
const MAX_MEMORY_RECORD_REASON_CODE_POINTS = 160;
const MAX_MEMORY_RECORD_AUDIT_SUMMARY_CODE_POINTS = 256;
const MAX_MEMORY_RECORD_CLASSIFICATION_CODE_POINTS = 96;
const RESTRICTED_MEMORY_TEXT = '[REDACTED:restricted_memory]';
const MAX_PRIVACY_PREFERENCE_ENTRIES = 100;
const MAX_PRIVACY_PREFERENCE_SCOPE_CATALOG_ENTRIES = 100;
const MAX_DISPLAY_PROFILE_SCOPE_CATALOG_ENTRIES = 100;
const MAX_DISPLAY_PROFILE_TARGET_ENTRIES = 100;
const MAX_DISPLAY_PROFILE_HISTORY_COUNT = 100;
const MAX_DISPLAY_PROFILE_TARGET_DETAIL_HISTORY_ENTRIES = 32;
const MAX_DISPLAY_PROFILE_DISPLAY_VALUE_CODE_POINTS = 160;
const DISPLAY_PROFILE_TARGET_RESOURCE_ID_DOMAIN =
  'lethebot-governance:display-profile-target-resource:v1\0';
const DISPLAY_PROFILE_REDACTION_SNAPSHOT_FINGERPRINT_DOMAIN =
  'lethebot-governance:display-profile-redaction-snapshot:v1\0';
const DISPLAY_PROFILE_REDACTION_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:display-profile-redaction-preview:v1\0';
const PLATFORM_ACCOUNT_UNLINK_TARGET_FINGERPRINT_DOMAIN =
  'lethebot-governance:platform-account-unlink-target:v1\0';
const PLATFORM_ACCOUNT_UNLINK_SNAPSHOT_FINGERPRINT_DOMAIN =
  'lethebot-governance:platform-account-unlink-snapshot:v1\0';
const PLATFORM_ACCOUNT_UNLINK_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:platform-account-unlink-preview:v1\0';
const NORMALIZED_QQ_PLATFORM_ACCOUNT_ID_PATTERN = /^[1-9][0-9]{4,11}$/u;
const MAX_GROUP_SUMMARY_POLICY_SCOPE_CATALOG_ENTRIES = 100;
const MAX_EXPLAIN_CONVERSATION_SCOPE_CATALOG_ENTRIES = 100;
const MAX_EXPLAIN_TURN_PAGE_ENTRIES = 100;
const MAX_EXPLAIN_TURN_DETAIL_ITEMS = 32;
const MAX_EXPLAIN_TURN_DETAIL_LABEL_CODE_POINTS = 96;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
const MODEL_INVOCATION_PURPOSES = ['summary', 'evaluator', 'pi_turn'] as const;
const MODEL_INVOCATION_STATUSES = ['running', 'completed', 'failed', 'aborted'] as const;
const MEMORY_RECORD_STATES: readonly MemoryRecord['state'][] = [
  'proposed',
  'active',
  'rejected',
  'superseded',
  'disabled',
  'deleted',
];
const RESTORABLE_MEMORY_RECORD_STATES: readonly RestorableMemoryRecordState[] = [
  'disabled',
  'rejected',
  'deleted',
];
const MEMORY_SOURCE_TYPES: readonly MemorySource['sourceType'][] = [
  'raw_event',
  'chat_message',
  'tool_output',
  'worker_extraction',
  'user_command',
];
const MEMORY_REVISION_CHANGE_TYPES: readonly MemoryRevision['changeType'][] = [
  'create',
  'update',
  'approve',
  'reject',
  'supersede',
  'disable',
  'delete',
  'restore',
];
const EXPLAIN_ACTION_TYPES: readonly ActionType[] = [
  'silent_store',
  'silent_summarize_later',
  'reply_short',
  'reply_full',
  'reply_with_tool',
  'propose_memory',
  'admin_digest',
  'schedule_background_task',
  'dm_user',
  'react_only',
  'send_folded_forward',
  'ask_clarification',
];
const MEMORY_MAINTENANCE_APPROVAL_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-maintenance-approval-preview:v1\0';
const MEMORY_MAINTENANCE_REJECTION_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-maintenance-rejection-preview:v1\0';
const MEMORY_MAINTENANCE_EXPIRATION_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-maintenance-expiration-preview:v1\0';
const MEMORY_MAINTENANCE_APPLICATION_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-maintenance-application-preview:v1\0';
const MEMORY_MAINTENANCE_APPLICATION_ROLE_FINGERPRINT_DOMAIN =
  'lethebot-governance:memory-maintenance-application-role:v1\0';
const MEMORY_MAINTENANCE_ROLLBACK_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-maintenance-rollback-preview:v1\0';
const MEMORY_MAINTENANCE_ROLLBACK_ROLE_FINGERPRINT_DOMAIN =
  'lethebot-governance:memory-maintenance-rollback-role:v1\0';
const MEMORY_RECORD_FORGET_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-record-forget-preview:v1\0';
const MEMORY_RECORD_RESTORE_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:memory-record-restore-preview:v1\0';
const PRIVACY_PREFERENCE_CHANGE_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:privacy-preference-change-preview:v1\0';
const GROUP_SUMMARY_POLICY_CHANGE_PREVIEW_DIGEST_DOMAIN =
  'lethebot-governance:group-summary-policy-change-preview:v1\0';
const PRIVACY_PREFERENCE_TYPES = [
  'proactive_dm',
  'memory_association',
] as const satisfies readonly PrivacyPreferenceType[];
const PRIVACY_PREFERENCE_STATES = [
  'opted_in',
  'opted_out',
] as const satisfies readonly PrivacyPreferenceState[];



interface MemorySourceRow {
  memory_id: string;
  source_type: string;
  source_id: string;
  source_timestamp: number;
  extracted_by: MemorySource['extractedBy'] | null;
}

interface MemoryRevisionRow {
  id: string;
  memory_id: string;
  revision_number: number;
  previous_state: string | null;
  new_state: string;
  reason: string;
  change_type: string;
  actor: string;
  evaluator_decision_id: string | null;
  created_at: number;
}

interface AuditRow {
  id: string;
  timestamp: number;
  category: string;
  level: string;
  event_type: string;
  event_id: string;
  actor_user_id: string | null;
  actor_class: string | null;
  invocation_context: string | null;
  summary: string;
  details: string | null;
  redacted: number;
  risk_level: string | null;
  evaluator_decision_id: string | null;
}


interface GovernanceExactScopeRow {
  scope: MemoryMaintenanceProposalExactScope['kind'];
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
}

type ExplainConversationScopeRow =
  | {
    conversation_id: string;
    conversation_type: 'private';
    group_id: null;
    latest_created_at: number;
  }
  | {
    conversation_id: string;
    conversation_type: 'group';
    group_id: string;
    latest_created_at: number;
  };

interface ExplainTurnScopeRow {
  id: string;
  status: ExplainTurnStatus;
  started_at: number;
  completed_at: number | null;
}

interface ExplainTurnDetailBaseRow extends ExplainTurnScopeRow {
  action_decision_id: string | null;
  trace_id: string;
  token_budget: string;
  candidate_memory_count: number;
  selected_memory_count: number;
  rejected_memory_count: number;
  recent_message_count: number;
  included_memory_count: number;
}

interface ExplainTurnDetailLabelRow {
  label: string;
}

interface ExplainTurnDetailActionTypeRow {
  action_type: unknown;
}

interface ExplainTurnDetailActionDecisionRow {
  id: string;
  decided_by: ActionDecision['decidedBy'];
  risk_level: ActionDecision['riskLevel'];
  confidence: number;
  evaluator_required: number;
  evaluator_passed: number | null;
  action_count: number;
  reason_count: number;
  suppressor_count: number;
}

interface ExplainTurnDetailExecutionRow {
  action_type: string;
  status: ActionExecutionResult['status'];
  executed_message: number;
  executed_memory: number;
  scheduled_job: number;
  downgraded_from: string | null;
  error_code: string | null;
  executed_at: number;
}

interface ExplainTurnDetailToolRow {
  tool_name: string;
  requested_by: ExplainTurnToolDetailInspectionRecord['requestedBy'];
  status: ToolCallResult['status'];
  error_code: string | null;
  execution_time_ms: number | null;
  secrets_redacted: number;
  created_at: number;
}

interface MemoryRecordScopeInspectionRow {
  id: string;
  scope: Exclude<MemoryRecord['scope'], 'tool'>;
  visibility: MemoryRecord['visibility'];
  sensitivity: MemoryRecord['sensitivity'];
  authority: MemoryRecord['authority'];
  kind: MemoryRecord['kind'];
  title: string;
  content: string;
  state: MemoryRecord['state'];
  confidence: number;
  importance: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  source_count: number;
  revision_count: number;
}

interface MemoryRecordDetailSourceRow {
  source_type: string;
  source_id: string;
  source_timestamp: number;
  extracted_by: string | null;
  resolution_state: string;
  total_count: number;
}

interface MemoryRecordDetailRevisionRow {
  id: string;
  revision_number: number;
  change_type: string;
  previous_state: string | null;
  new_state: string;
  reason: string | null;
  actor: string;
  evaluator_decision_id: string | null;
  created_at: number;
  total_count: number;
}

interface MemoryRecordDetailAuditRow {
  id: string;
  timestamp: number;
  level: string;
  event_type: string;
  summary: string;
  risk_level: string | null;
  evaluator_decision_id: string | null;
}

interface MemoryRecordForgetPreviewRow {
  id: string;
  scope: MemoryMaintenanceProposalExactScope['kind'];
  state: unknown;
  current_revision_number: unknown;
}

interface MemoryRecordRestorePreviewRow {
  id: string;
  scope: MemoryMaintenanceProposalExactScope['kind'];
  state: unknown;
  current_revision_number: unknown;
}

interface GroupSummaryPolicyInspectionRow {
  state: unknown;
  generation: unknown;
  eligible_after: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface PrivacyPreferenceChangePreviewRow {
  preference_exists: unknown;
  state: unknown;
  updated_at: unknown;
}

interface DisplayProfileTargetInspectionRow {
  source_group_id: string;
  profile_present: 0 | 1;
  profile_trust: DisplayProfileTrust | null;
  profile_observed_at: number | null;
  history_count_probe: number;
  history_latest_observed_at: number | null;
  history_has_open: 0 | 1;
  history_has_closed: 0 | 1;
}

interface DisplayProfileTargetSelection {
  scope: DisplayProfileScope;
  rows: DisplayProfileTargetInspectionRow[];
  truncated: boolean;
}

interface DisplayProfileCurrentValueRow {
  current_display_name: string;
}

interface DisplayProfileNicknameHistoryDetailRow {
  id: string;
  display_name: string;
  observed_at: number;
  observed_until: number | null;
}

interface DisplayProfileRedactionSnapshotProfileRow {
  current_display_name_type: string;
  current_display_name_hex: string;
  observed_at_type: string;
  observed_at_hex: string;
  trust_type: string;
  trust_hex: string;
}

interface DisplayProfileRedactionSnapshotHistoryRow {
  history_id_type: string;
  history_id_hex: string;
  display_name_type: string;
  display_name_hex: string;
  observed_at_type: string;
  observed_at_hex: string;
  observed_until_type: string;
  observed_until_hex: string;
}

interface PlatformAccountUnlinkPreviewRow {
  platform: unknown;
  platform_account_id: unknown;
  canonical_user_id: unknown;
  account_type: unknown;
  verified_level: unknown;
  status: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  platform_type: unknown;
  platform_hex: unknown;
  platform_account_id_type: unknown;
  platform_account_id_hex: unknown;
  canonical_user_id_type: unknown;
  canonical_user_id_hex: unknown;
  account_type_type: unknown;
  account_type_hex: unknown;
  verified_level_type: unknown;
  verified_level_hex: unknown;
  status_type: unknown;
  status_hex: unknown;
  first_seen_at_type: unknown;
  first_seen_at_hex: unknown;
  last_seen_at_type: unknown;
  last_seen_at_hex: unknown;
}

export type PlatformAccountUnlinkSnapshotReadResult =
  | {
    outcome: 'found';
    canonicalUserId: string;
    accountType: PlatformAccountUnlinkPreviewProjection['account']['accountType'];
    verifiedLevel: PlatformAccountUnlinkPreviewProjection['account']['verifiedLevel'];
    firstSeenAt: number;
    lastSeenAt: number;
    snapshot: PlatformAccountUnlinkSnapshot;
  }
  | { outcome: 'not_found' | 'invalid' };

export function readPlatformAccountUnlinkSnapshot(
  db: Database.Database,
  input: {
    platform: 'qq';
    platformAccountId: string;
  },
): PlatformAccountUnlinkSnapshotReadResult {
  if (
    input.platform !== 'qq'
    || typeof input.platformAccountId !== 'string'
    || !NORMALIZED_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(input.platformAccountId)
  ) {
    return { outcome: 'invalid' };
  }
  const row = db.prepare(
    `SELECT platform,
            platform_account_id,
            canonical_user_id,
            account_type,
            verified_level,
            status,
            first_seen_at,
            last_seen_at,
            typeof(platform) AS platform_type,
            hex(platform) AS platform_hex,
            typeof(platform_account_id) AS platform_account_id_type,
            hex(platform_account_id) AS platform_account_id_hex,
            typeof(canonical_user_id) AS canonical_user_id_type,
            hex(canonical_user_id) AS canonical_user_id_hex,
            typeof(account_type) AS account_type_type,
            hex(account_type) AS account_type_hex,
            typeof(verified_level) AS verified_level_type,
            hex(verified_level) AS verified_level_hex,
            typeof(status) AS status_type,
            hex(status) AS status_hex,
            typeof(first_seen_at) AS first_seen_at_type,
            hex(first_seen_at) AS first_seen_at_hex,
            typeof(last_seen_at) AS last_seen_at_type,
            hex(last_seen_at) AS last_seen_at_hex
       FROM platform_accounts
      WHERE platform = ? AND platform_account_id = ?
      LIMIT 1`,
  ).get(input.platform, input.platformAccountId) as
    PlatformAccountUnlinkPreviewRow | undefined;
  if (!row) {
    return { outcome: 'not_found' };
  }
  if (row.status === 'disabled' || row.status === 'deleted') {
    return { outcome: 'not_found' };
  }

  const accountType = ['private', 'group_member', 'temp_session'].find(
    (candidate) => candidate === row.account_type,
  ) as PlatformAccountUnlinkPreviewProjection['account']['accountType'] | undefined;
  const verifiedLevel = ['observed', 'self_claimed', 'owner_verified'].find(
    (candidate) => candidate === row.verified_level,
  ) as PlatformAccountUnlinkPreviewProjection['account']['verifiedLevel'] | undefined;
  const canonicalUserCharacters = typeof row.canonical_user_id === 'string'
    ? Array.from(row.canonical_user_id)
    : [];
  const storageTypes = [
    row.platform_type,
    row.platform_account_id_type,
    row.canonical_user_id_type,
    row.account_type_type,
    row.verified_level_type,
    row.status_type,
    row.first_seen_at_type,
    row.last_seen_at_type,
  ];
  const storageHexValues = [
    row.platform_hex,
    row.platform_account_id_hex,
    row.canonical_user_id_hex,
    row.account_type_hex,
    row.verified_level_hex,
    row.status_hex,
    row.first_seen_at_hex,
    row.last_seen_at_hex,
  ];
  if (
    row.platform !== 'qq'
    || row.platform_account_id !== input.platformAccountId
    || typeof row.canonical_user_id !== 'string'
    || row.canonical_user_id.trim() !== row.canonical_user_id
    || canonicalUserCharacters.length < 1
    || canonicalUserCharacters.length > 256
    || !canonicalUserCharacters.every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || (codePoint > 31 && codePoint !== 127);
    })
    || !accountType
    || !verifiedLevel
    || row.status !== 'active'
    || typeof row.first_seen_at !== 'number'
    || !Number.isSafeInteger(row.first_seen_at)
    || row.first_seen_at < 0
    || row.first_seen_at > MAX_JAVASCRIPT_DATE_MS
    || typeof row.last_seen_at !== 'number'
    || !Number.isSafeInteger(row.last_seen_at)
    || row.last_seen_at < row.first_seen_at
    || row.last_seen_at > MAX_JAVASCRIPT_DATE_MS
    || row.platform_type !== 'text'
    || row.platform_account_id_type !== 'text'
    || row.canonical_user_id_type !== 'text'
    || row.account_type_type !== 'text'
    || row.verified_level_type !== 'text'
    || row.status_type !== 'text'
    || row.first_seen_at_type !== 'integer'
    || row.last_seen_at_type !== 'integer'
    || !storageTypes.every((value) => typeof value === 'string')
    || !storageHexValues.every((value) => (
      typeof value === 'string' && /^(?:[0-9A-F]{2})+$/u.test(value)
    ))
  ) {
    return { outcome: 'invalid' };
  }

  const storageFields = storageTypes.flatMap((type, index) => [
    type,
    storageHexValues[index],
  ]);
  return {
    outcome: 'found',
    canonicalUserId: row.canonical_user_id,
    accountType,
    verifiedLevel,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    snapshot: {
      snapshotFingerprint: createHash('sha256')
        .update(PLATFORM_ACCOUNT_UNLINK_SNAPSHOT_FINGERPRINT_DOMAIN, 'utf8')
        .update(JSON.stringify(storageFields), 'utf8')
        .digest('hex'),
    },
  };
}

export type DisplayProfileRedactionSnapshotReadResult =
  | { outcome: 'found'; snapshot: DisplayProfileRedactionSnapshot }
  | { outcome: 'not_found' | 'invalid' };

export function deriveDisplayProfileTargetResourceId(
  scope: DisplayProfileScope,
  sourceGroupId: string,
): string {
  return createHash('sha256')
    .update(DISPLAY_PROFILE_TARGET_RESOURCE_ID_DOMAIN, 'utf8')
    .update(JSON.stringify({
      canonicalUserId: scope.canonicalUserId,
      sourceGroupId,
    }), 'utf8')
    .digest('hex');
}

export function readDisplayProfileRedactionSnapshot(
  db: Database.Database,
  input: {
    scope: DisplayProfileScope;
    sourceGroupId: string;
    targetId: string;
  },
): DisplayProfileRedactionSnapshotReadResult {
  const snapshotHash = createHash('sha256')
    .update(DISPLAY_PROFILE_REDACTION_SNAPSHOT_FINGERPRINT_DOMAIN, 'utf8')
    .update(input.targetId, 'utf8');
  let displayProfileRows = 0;
  const profileRows = db.prepare(
    `SELECT typeof(current_display_name) AS current_display_name_type,
            hex(current_display_name) AS current_display_name_hex,
            typeof(observed_at) AS observed_at_type,
            hex(observed_at) AS observed_at_hex,
            typeof(trust) AS trust_type,
            hex(trust) AS trust_hex
       FROM display_profiles
      WHERE canonical_user_id = ?
        AND source_group_id = ?`,
  ).iterate(
    input.scope.canonicalUserId,
    input.sourceGroupId,
  ) as Iterable<DisplayProfileRedactionSnapshotProfileRow>;
  for (const row of profileRows) {
    if (displayProfileRows === Number.MAX_SAFE_INTEGER) {
      return { outcome: 'invalid' };
    }
    displayProfileRows += 1;
    snapshotHash
      .update('\0display_profile\0', 'utf8')
      .update(JSON.stringify([
        row.current_display_name_type,
        row.current_display_name_hex,
        row.observed_at_type,
        row.observed_at_hex,
        row.trust_type,
        row.trust_hex,
      ]), 'utf8');
  }

  let nicknameHistoryRows = 0;
  let openNicknameHistoryRows = 0;
  const historyRows = db.prepare(
    `SELECT typeof(id) AS history_id_type,
            hex(id) AS history_id_hex,
            typeof(display_name) AS display_name_type,
            hex(display_name) AS display_name_hex,
            typeof(observed_at) AS observed_at_type,
            hex(observed_at) AS observed_at_hex,
            typeof(observed_until) AS observed_until_type,
            hex(observed_until) AS observed_until_hex
       FROM nickname_history
      WHERE canonical_user_id = ?
        AND source_group_id = ?
      ORDER BY history_id_type ASC, history_id_hex ASC`,
  ).iterate(
    input.scope.canonicalUserId,
    input.sourceGroupId,
  ) as Iterable<DisplayProfileRedactionSnapshotHistoryRow>;
  for (const row of historyRows) {
    if (
      nicknameHistoryRows === Number.MAX_SAFE_INTEGER
      || (row.observed_until_type === 'null'
        && openNicknameHistoryRows === Number.MAX_SAFE_INTEGER)
    ) {
      return { outcome: 'invalid' };
    }
    nicknameHistoryRows += 1;
    if (row.observed_until_type === 'null') {
      openNicknameHistoryRows += 1;
    }
    snapshotHash
      .update('\0nickname_history\0', 'utf8')
      .update(JSON.stringify([
        row.history_id_type,
        row.history_id_hex,
        row.display_name_type,
        row.display_name_hex,
        row.observed_at_type,
        row.observed_at_hex,
        row.observed_until_type,
        row.observed_until_hex,
      ]), 'utf8');
  }

  const total = displayProfileRows + nicknameHistoryRows;
  if (!Number.isSafeInteger(total)) {
    return { outcome: 'invalid' };
  }
  if (total < 1) {
    return { outcome: 'not_found' };
  }
  return {
    outcome: 'found',
    snapshot: {
      displayProfileRows,
      nicknameHistoryRows,
      openNicknameHistoryRows,
      snapshotFingerprint: snapshotHash.digest('hex'),
    },
  };
}

export class GovernanceQueryService {
  private readonly maintenanceProposals: MemoryMaintenanceProposalRepository;
  private readonly memories: MemoryRepository;

  constructor(private readonly db: Database.Database) {
    this.maintenanceProposals = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    );
    this.memories = new MemoryRepository(db);
  }

  async listMemoryMaintenanceReviewScopes(): Promise<MemoryMaintenanceReviewScopeCatalog> {
    const catalog = this.readMemoryMaintenanceReviewScopeRows();
    return {
      entries: catalog.rows.map((row) => this.memoryMaintenanceReviewScopeToCatalogEntry(row)),
      truncated: catalog.truncated,
    };
  }

  async listMemoryMaintenanceReviewScopeHandles(
    issueHandle: MemoryMaintenanceReviewScopeHandleIssuer,
  ): Promise<MemoryMaintenanceReviewScopeHandleCatalog> {
    const catalog = this.readMemoryMaintenanceReviewScopeRows();
    const entries: MemoryMaintenanceReviewScopeHandleCatalogEntry[] = [];
    for (const row of catalog.rows) {
      const scope = this.memoryMaintenanceReviewScopeFromRow(row);
      const catalogEntry = this.memoryMaintenanceReviewScopeToCatalogEntry(row);
      const issued = await issueHandle(scope);
      entries.push({
        fingerprint: catalogEntry.fingerprint,
        scopeKind: catalogEntry.scopeKind,
        ...(catalogEntry.conversationType === undefined
          ? {}
          : { conversationType: catalogEntry.conversationType }),
        label: catalogEntry.label,
        handle: issued.handle,
        expiresAt: issued.expiresAt,
      });
    }
    return { entries, truncated: catalog.truncated };
  }

  async listMemoryRecordScopeHandles(
    issueHandle: MemoryRecordScopeHandleIssuer,
  ): Promise<MemoryRecordScopeHandleCatalog> {
    const catalog = this.readMemoryRecordScopeRows();
    const entries: MemoryRecordScopeHandleCatalogEntry[] = [];
    for (const row of catalog.rows) {
      const scope = this.memoryMaintenanceReviewScopeFromRow(row);
      const catalogEntry = this.memoryMaintenanceReviewScopeToCatalogEntry(row);
      const issued = await issueHandle(scope);
      entries.push({
        fingerprint: catalogEntry.fingerprint,
        scopeKind: catalogEntry.scopeKind,
        ...(catalogEntry.conversationType === undefined
          ? {}
          : { conversationType: catalogEntry.conversationType }),
        label: catalogEntry.label,
        handle: issued.handle,
        expiresAt: issued.expiresAt,
      });
    }
    return { entries, truncated: catalog.truncated };
  }

  async listPrivacyPreferenceScopeHandles(
    issueHandle: PrivacyPreferenceScopeHandleIssuer,
  ): Promise<PrivacyPreferenceScopeHandleCatalog> {
    const rows = this.db.prepare(
      `SELECT id
         FROM canonical_users
        WHERE typeof(id) = 'text' AND length(id) > 0 AND id = trim(id)
        ORDER BY last_seen_at DESC, id ASC
        LIMIT ?`,
    ).all(MAX_PRIVACY_PREFERENCE_SCOPE_CATALOG_ENTRIES + 1) as Array<{ id: string }>;
    const entries: PrivacyPreferenceScopeHandleCatalogEntry[] = [];
    for (const row of rows.slice(0, MAX_PRIVACY_PREFERENCE_SCOPE_CATALOG_ENTRIES)) {
      const scope: PrivacyPreferenceScope = {
        kind: 'user',
        canonicalUserId: row.id,
      };
      const issued = await issueHandle(scope);
      entries.push({
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: 'user',
        label: 'User privacy',
        handle: issued.handle,
        expiresAt: issued.expiresAt,
      });
    }
    return {
      entries,
      truncated: rows.length > MAX_PRIVACY_PREFERENCE_SCOPE_CATALOG_ENTRIES,
    };
  }

  async listDisplayProfileScopeHandles(
    issueHandle: DisplayProfileScopeHandleIssuer,
  ): Promise<DisplayProfileScopeHandleCatalog> {
    const rows = this.db.prepare(
      `WITH trim_characters(value) AS (
         VALUES (
           ' ' || char(
             160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
             8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279
           )
         )
       ), profile_evidence(canonical_user_id) AS (
         SELECT canonical_user_id FROM display_profiles
         UNION ALL
         SELECT canonical_user_id FROM nickname_history
       ), valid_evidence(canonical_user_id) AS (
         SELECT canonical_user_id
           FROM profile_evidence
          WHERE typeof(canonical_user_id) = 'text'
            AND length(canonical_user_id) BETWEEN 1 AND 256
            AND canonical_user_id = trim(
              canonical_user_id,
              (SELECT value FROM trim_characters)
            )
            AND instr(canonical_user_id, char(0)) = 0
            AND canonical_user_id NOT GLOB
              ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
       ), distinct_users(canonical_user_id) AS (
         SELECT canonical_user_id
           FROM valid_evidence
          GROUP BY canonical_user_id
       )
       SELECT canonical_user_id
         FROM distinct_users
        ORDER BY canonical_user_id ASC
        LIMIT ?`,
    ).all(MAX_DISPLAY_PROFILE_SCOPE_CATALOG_ENTRIES + 1) as Array<{
      canonical_user_id: string;
    }>;
    const entries: DisplayProfileScopeHandleCatalogEntry[] = [];
    for (const row of rows.slice(0, MAX_DISPLAY_PROFILE_SCOPE_CATALOG_ENTRIES)) {
      const scope: DisplayProfileScope = {
        kind: 'user',
        canonicalUserId: row.canonical_user_id,
      };
      const issued = await issueHandle(scope);
      entries.push({
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: 'user',
        label: 'User display data',
        handle: issued.handle,
        expiresAt: issued.expiresAt,
      });
    }
    return {
      entries,
      truncated: rows.length > MAX_DISPLAY_PROFILE_SCOPE_CATALOG_ENTRIES,
    };
  }

  async listDisplayProfileTargetsForScope(
    scope: GovernanceQueryScope,
  ): Promise<DisplayProfileTargetInspectionPage> {
    const page = this.selectDisplayProfileTargetRows(scope);
    if (!page) {
      return { entries: [], truncated: false };
    }
    return {
      entries: page.rows.map((row) => this.displayProfileTargetRowToInspection(
        page.scope,
        row,
      )),
      truncated: page.truncated,
    };
  }

  async listDisplayProfileTargetResourceHandlePage(
    scope: GovernanceQueryScope,
    issueHandle: DisplayProfileTargetResourceHandleIssuer,
  ): Promise<DisplayProfileTargetResourceHandlePage> {
    const page = this.selectDisplayProfileTargetRows(scope);
    if (!page) {
      return { entries: [], truncated: false };
    }
    const entries: DisplayProfileTargetResourceHandleInspectionRecord[] = [];
    for (const row of page.rows) {
      const targetId = deriveDisplayProfileTargetResourceId(
        page.scope,
        row.source_group_id,
      );
      const issued = await issueHandle({ scope: page.scope, targetId });
      entries.push({
        ...this.displayProfileTargetRowToInspection(page.scope, row),
        handle: issued.handle,
        handleExpiresAt: issued.expiresAt,
      });
    }
    return { entries, truncated: page.truncated };
  }

  async getDisplayProfileTargetDetailForScope(input: {
    scope: GovernanceQueryScope;
    targetId: string;
  }): Promise<DisplayProfileTargetDetailInspectionRecord | null> {
    if (
      typeof input.targetId !== 'string'
      || !/^[0-9a-f]{64}$/u.test(input.targetId)
    ) {
      return null;
    }
    const page = this.selectDisplayProfileTargetRows(input.scope);
    if (!page) {
      return null;
    }
    const targetRow = page.rows.find((row) => (
      deriveDisplayProfileTargetResourceId(page.scope, row.source_group_id) === input.targetId
    ));
    if (!targetRow) {
      return null;
    }

    const currentRow = targetRow.profile_present === 1
      ? this.db.prepare(
        `SELECT current_display_name
           FROM display_profiles
          WHERE canonical_user_id = ?
            AND source_group_id = ?
            AND typeof(current_display_name) = 'text'
            AND trust IN ('platform_provided', 'user_set', 'inferred')
            AND typeof(observed_at) = 'integer'
            AND observed_at BETWEEN 0 AND ?
          LIMIT 1`,
      ).get(
        page.scope.canonicalUserId,
        targetRow.source_group_id,
        MAX_JAVASCRIPT_DATE_MS,
      ) as DisplayProfileCurrentValueRow | undefined
      : undefined;
    const historyRows = targetRow.history_count_probe > 0
      ? this.db.prepare(
        `WITH trim_characters(value) AS (
           VALUES (
             ' ' || char(
               160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
               8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279
             )
           )
         )
         SELECT id, display_name, observed_at, observed_until
           FROM nickname_history
          WHERE canonical_user_id = ?
            AND source_group_id = ?
            AND typeof(id) = 'text'
            AND length(id) BETWEEN 1 AND 256
            AND id = trim(id, (SELECT value FROM trim_characters))
            AND instr(id, char(0)) = 0
            AND id NOT GLOB
              ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
            AND typeof(display_name) = 'text'
            AND typeof(observed_at) = 'integer'
            AND observed_at BETWEEN 0 AND ?
            AND (
              observed_until IS NULL
              OR (
                typeof(observed_until) = 'integer'
                AND observed_until BETWEEN observed_at AND ?
              )
            )
          ORDER BY observed_at DESC, id DESC
          LIMIT ?`,
      ).all(
        page.scope.canonicalUserId,
        targetRow.source_group_id,
        MAX_JAVASCRIPT_DATE_MS,
        MAX_JAVASCRIPT_DATE_MS,
        MAX_DISPLAY_PROFILE_TARGET_DETAIL_HISTORY_ENTRIES + 1,
      ) as DisplayProfileNicknameHistoryDetailRow[]
      : [];

    return {
      target: this.displayProfileTargetRowToInspection(page.scope, targetRow),
      currentDisplay: currentRow
        ? this.displayProfileValueToInspection(currentRow.current_display_name)
        : null,
      nicknameHistory: historyRows
        .slice(0, MAX_DISPLAY_PROFILE_TARGET_DETAIL_HISTORY_ENTRIES)
        .map((row) => ({
          fingerprint: this.governanceReference(
            'display-profile-nickname-history',
            row.id,
          ),
          ...this.displayProfileValueToInspection(row.display_name),
          observedAt: new Date(row.observed_at),
          observedUntil: row.observed_until === null
            ? null
            : new Date(row.observed_until),
        })),
      nicknameHistoryTruncated:
        historyRows.length > MAX_DISPLAY_PROFILE_TARGET_DETAIL_HISTORY_ENTRIES,
    };
  }

  async getDisplayProfileTargetRedactionPreviewForScope(input: {
    scope: GovernanceQueryScope;
    targetId: string;
  }): Promise<DisplayProfileTargetRedactionPreviewProjection | null> {
    if (
      typeof input.targetId !== 'string'
      || !/^[0-9a-f]{64}$/u.test(input.targetId)
    ) {
      return null;
    }
    const page = this.selectDisplayProfileTargetRows(input.scope);
    if (!page) {
      return null;
    }
    const targetRow = page.rows.find((row) => (
      deriveDisplayProfileTargetResourceId(page.scope, row.source_group_id) === input.targetId
    ));
    if (!targetRow) {
      return null;
    }

    const snapshotResult = readDisplayProfileRedactionSnapshot(this.db, {
      scope: page.scope,
      sourceGroupId: targetRow.source_group_id,
      targetId: input.targetId,
    });
    if (snapshotResult.outcome !== 'found') {
      return null;
    }
    const {
      displayProfileRows,
      nicknameHistoryRows,
      openNicknameHistoryRows,
    } = snapshotResult.snapshot;
    const total = displayProfileRows + nicknameHistoryRows;
    const durableEffects:
      DisplayProfileTargetRedactionPreviewProjection['expected']['durableEffects'] = [];
    if (displayProfileRows > 0) {
      durableEffects.push('display_profile_rows_redacted');
    }
    if (nicknameHistoryRows > 0) {
      durableEffects.push('nickname_history_rows_redacted');
    }
    if (openNicknameHistoryRows > 0) {
      durableEffects.push('open_nickname_history_rows_closed');
    }
    durableEffects.push('audit_event_append');
    const privacyConsequences:
      DisplayProfileTargetRedactionPreviewProjection['expected']['privacyConsequences'] = [
        'display_values_enforced_as_redacted',
      ];
    if (openNicknameHistoryRows > 0) {
      privacyConsequences.push('open_history_intervals_closed');
    }

    const payload: Omit<DisplayProfileTargetRedactionPreviewProjection, 'previewDigest'> = {
      action: DISPLAY_PROFILE_REDACTION_ACTION,
      target: this.displayProfileTargetRowToInspection(page.scope, targetRow),
      current: snapshotResult.snapshot,
      expected: {
        affectedRows: {
          displayProfiles: displayProfileRows,
          nicknameHistory: nicknameHistoryRows,
          total,
        },
        durableEffects,
        privacyConsequences,
      },
      rollback: {
        supported: false,
        boundary: 'redacted_display_values_are_not_recoverable',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(DISPLAY_PROFILE_REDACTION_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async resolveDisplayProfileTargetRedactionMutationForScope(input: {
    scope: GovernanceQueryScope;
    targetId: string;
  }): Promise<DisplayProfileTargetRedactionMutationSelection | null> {
    if (
      typeof input.targetId !== 'string'
      || !/^[0-9a-f]{64}$/u.test(input.targetId)
    ) {
      return null;
    }
    const page = this.selectDisplayProfileTargetRows(input.scope);
    if (!page) {
      return null;
    }
    const targetRow = page.rows.find((row) => (
      deriveDisplayProfileTargetResourceId(page.scope, row.source_group_id) === input.targetId
    ));
    if (!targetRow) {
      return null;
    }
    return {
      canonicalUserId: page.scope.canonicalUserId,
      groupId: targetRow.source_group_id === '' ? null : targetRow.source_group_id,
      targetId: input.targetId,
    };
  }

  async getPlatformAccountUnlinkPreview(input: {
    platform: 'qq';
    platformAccountId: string;
  }): Promise<PlatformAccountUnlinkPreviewProjection | null> {
    if (
      input.platform !== 'qq'
      || typeof input.platformAccountId !== 'string'
      || !NORMALIZED_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(input.platformAccountId)
    ) {
      return null;
    }
    const snapshotResult = readPlatformAccountUnlinkSnapshot(this.db, input);
    if (snapshotResult.outcome !== 'found') {
      return null;
    }

    const target = JSON.stringify({
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      canonicalUserId: snapshotResult.canonicalUserId,
    });
    const payload: Omit<PlatformAccountUnlinkPreviewProjection, 'previewDigest'> = {
      action: PLATFORM_ACCOUNT_UNLINK_ACTION,
      account: {
        fingerprint: createHash('sha256')
          .update(PLATFORM_ACCOUNT_UNLINK_TARGET_FINGERPRINT_DOMAIN, 'utf8')
          .update(target, 'utf8')
          .digest('hex')
          .slice(0, 16),
        platform: 'qq',
        accountType: snapshotResult.accountType,
        verifiedLevel: snapshotResult.verifiedLevel,
        status: 'active',
        firstSeenAt: new Date(snapshotResult.firstSeenAt),
        lastSeenAt: new Date(snapshotResult.lastSeenAt),
      },
      current: snapshotResult.snapshot,
      expected: {
        status: 'disabled',
        durableEffects: ['platform_account_status_disabled', 'audit_event_append'],
        identityConsequences: ['future_identity_resolution_blocked'],
        privacyConsequences: ['platform_account_mapping_retained'],
      },
      rollback: {
        supported: false,
        boundary: 'platform_account_relink_not_available',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(PLATFORM_ACCOUNT_UNLINK_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  private displayProfileValueToInspection(
    value: string,
  ): DisplayProfileDisplayValueInspectionRecord {
    const projected = projectBoundedGovernanceText(
      value,
      MAX_DISPLAY_PROFILE_DISPLAY_VALUE_CODE_POINTS,
    );
    return {
      value: projected.text,
      redacted: projected.redacted,
      truncated: projected.truncated,
    };
  }

  private selectDisplayProfileTargetRows(
    scope: GovernanceQueryScope,
  ): DisplayProfileTargetSelection | null {
    if (
      !scope
      || typeof scope !== 'object'
      || scope.kind !== 'user'
      || !this.isDisplayProfileIdentifier(scope.canonicalUserId)
    ) {
      return null;
    }
    const normalizedScope: DisplayProfileScope = {
      kind: 'user',
      canonicalUserId: scope.canonicalUserId,
    };

    const historyCountProbe = MAX_DISPLAY_PROFILE_HISTORY_COUNT + 1;
    const rows = this.db.prepare(
      `WITH trim_characters(value) AS (
         VALUES (
           ' ' || char(
             160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
             8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279
           )
         )
       ), valid_profiles AS (
         SELECT source_group_id, trust, observed_at
           FROM display_profiles
          WHERE canonical_user_id = ?
            AND (
              source_group_id = ''
              OR (
                typeof(source_group_id) = 'text'
                AND length(source_group_id) BETWEEN 1 AND 256
                AND source_group_id = trim(
                  source_group_id,
                  (SELECT value FROM trim_characters)
                )
                AND instr(source_group_id, char(0)) = 0
                AND source_group_id NOT GLOB
                  ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
              )
            )
            AND trust IN ('platform_provided', 'user_set', 'inferred')
            AND typeof(observed_at) = 'integer'
            AND observed_at BETWEEN 0 AND ?
       ), valid_history AS (
         SELECT id, source_group_id, observed_at, observed_until
           FROM nickname_history
          WHERE canonical_user_id = ?
            AND (
              source_group_id = ''
              OR (
                typeof(source_group_id) = 'text'
                AND length(source_group_id) BETWEEN 1 AND 256
                AND source_group_id = trim(
                  source_group_id,
                  (SELECT value FROM trim_characters)
                )
                AND instr(source_group_id, char(0)) = 0
                AND source_group_id NOT GLOB
                  ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
              )
            )
            AND typeof(observed_at) = 'integer'
            AND observed_at BETWEEN 0 AND ?
            AND (
              observed_until IS NULL
              OR (
                typeof(observed_until) = 'integer'
                AND observed_until BETWEEN observed_at AND ?
              )
            )
       ), distinct_targets AS (
         SELECT source_group_id FROM valid_profiles
         UNION
         SELECT source_group_id FROM valid_history
       ), target_probe AS (
         SELECT source_group_id
           FROM distinct_targets
         ORDER BY CASE WHEN source_group_id = '' THEN 0 ELSE 1 END,
                  source_group_id ASC
         LIMIT ?
       ), history_probe AS (
         SELECT source_group_id, observed_at, observed_until
           FROM (
             SELECT id, source_group_id, observed_at, observed_until,
                    ROW_NUMBER() OVER (
                      PARTITION BY source_group_id
                      ORDER BY observed_at DESC, id DESC
                    ) AS row_number
               FROM valid_history
              WHERE source_group_id IN (SELECT source_group_id FROM target_probe)
           )
          WHERE row_number <= ?
       ), history_summary AS (
         SELECT source_group_id,
                COUNT(*) AS history_count_probe,
                MAX(observed_at) AS history_latest_observed_at,
                MAX(CASE WHEN observed_until IS NULL THEN 1 ELSE 0 END)
                  AS history_has_open,
                MAX(CASE WHEN observed_until IS NULL THEN 0 ELSE 1 END)
                  AS history_has_closed
           FROM history_probe
          GROUP BY source_group_id
       )
       SELECT target.source_group_id,
              CASE WHEN profile.source_group_id IS NULL THEN 0 ELSE 1 END
                AS profile_present,
              profile.trust AS profile_trust,
              profile.observed_at AS profile_observed_at,
              COALESCE(history.history_count_probe, 0) AS history_count_probe,
              history.history_latest_observed_at,
              COALESCE(history.history_has_open, 0) AS history_has_open,
              COALESCE(history.history_has_closed, 0) AS history_has_closed
         FROM target_probe target
         LEFT JOIN valid_profiles profile
           ON profile.source_group_id = target.source_group_id
         LEFT JOIN history_summary history
           ON history.source_group_id = target.source_group_id
        ORDER BY CASE WHEN target.source_group_id = '' THEN 0 ELSE 1 END,
                 target.source_group_id ASC`,
    ).all(
      normalizedScope.canonicalUserId,
      MAX_JAVASCRIPT_DATE_MS,
      normalizedScope.canonicalUserId,
      MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      MAX_DISPLAY_PROFILE_TARGET_ENTRIES + 1,
      historyCountProbe,
    ) as DisplayProfileTargetInspectionRow[];

    return {
      scope: normalizedScope,
      rows: rows.slice(0, MAX_DISPLAY_PROFILE_TARGET_ENTRIES),
      truncated: rows.length > MAX_DISPLAY_PROFILE_TARGET_ENTRIES,
    };
  }

  private displayProfileTargetRowToInspection(
    scope: DisplayProfileScope,
    row: DisplayProfileTargetInspectionRow,
  ): DisplayProfileTargetInspectionRecord {
    const historyLifecycle: DisplayProfileHistoryLifecycle =
      row.history_has_open === 1 && row.history_has_closed === 1
        ? 'mixed'
        : row.history_has_open === 1
          ? 'open'
          : row.history_has_closed === 1
            ? 'closed'
            : 'absent';
    const privateOrGlobal = row.source_group_id === '';
    return {
      fingerprint: this.governanceReference(
        'display-profile-target',
        JSON.stringify({
          canonicalUserId: scope.canonicalUserId,
          sourceGroupId: row.source_group_id,
        }),
      ),
      targetKind: privateOrGlobal ? 'private_or_global' : 'group',
      label: privateOrGlobal
        ? 'Private/global display data'
        : 'Group display data',
      currentProfile: {
        present: row.profile_present === 1,
        trust: row.profile_trust,
        observedAt: row.profile_observed_at === null
          ? null
          : new Date(row.profile_observed_at),
      },
      history: {
        count: Math.min(
          row.history_count_probe,
          MAX_DISPLAY_PROFILE_HISTORY_COUNT,
        ),
        truncated: row.history_count_probe > MAX_DISPLAY_PROFILE_HISTORY_COUNT,
        lifecycle: historyLifecycle,
        latestObservedAt: row.history_latest_observed_at === null
          ? null
          : new Date(row.history_latest_observed_at),
      },
    };
  }

  async listGroupSummaryPolicyScopeHandles(
    issueHandle: GroupSummaryPolicyScopeHandleIssuer,
  ): Promise<GroupSummaryPolicyScopeHandleCatalog> {
    const rows = this.db.prepare(
      `WITH bounds(maximum_date) AS (VALUES (?)), valid_evidence AS (
         SELECT group_id, timestamp AS evidence_at
           FROM chat_messages
          WHERE conversation_type = 'group'
            AND typeof(group_id) = 'text'
            AND typeof(conversation_id) = 'text'
            AND conversation_id = group_id
            AND length(group_id) BETWEEN 14 AND 21
            AND substr(group_id, 1, 9) = 'qq-group-'
            AND substr(group_id, 10, 1) BETWEEN '1' AND '9'
            AND substr(group_id, 10) NOT GLOB '*[^0-9]*'
            AND typeof(timestamp) = 'integer'
            AND timestamp BETWEEN 0 AND (SELECT maximum_date FROM bounds)
         UNION ALL
         SELECT group_id, updated_at AS evidence_at
           FROM group_summary_policies
          WHERE typeof(group_id) = 'text'
            AND length(group_id) BETWEEN 14 AND 21
            AND substr(group_id, 1, 9) = 'qq-group-'
            AND substr(group_id, 10, 1) BETWEEN '1' AND '9'
            AND substr(group_id, 10) NOT GLOB '*[^0-9]*'
            AND state IN ('enabled', 'disabled')
            AND typeof(generation) = 'integer'
            AND generation >= 1
            AND typeof(created_at) = 'integer'
            AND created_at BETWEEN 0 AND (SELECT maximum_date FROM bounds)
            AND typeof(updated_at) = 'integer'
            AND updated_at BETWEEN created_at AND (SELECT maximum_date FROM bounds)
            AND (
              (
                state = 'enabled'
                AND typeof(eligible_after) = 'integer'
                AND eligible_after BETWEEN 0 AND (SELECT maximum_date FROM bounds)
              )
              OR (state = 'disabled' AND eligible_after IS NULL)
            )
       ), distinct_groups AS (
         SELECT group_id, MAX(evidence_at) AS latest_evidence_at
           FROM valid_evidence
          GROUP BY group_id
       )
       SELECT group_id
         FROM distinct_groups
        ORDER BY latest_evidence_at DESC, group_id ASC
        LIMIT ?`,
    ).all(
      MAX_JAVASCRIPT_DATE_MS,
      MAX_GROUP_SUMMARY_POLICY_SCOPE_CATALOG_ENTRIES + 1,
    ) as Array<{ group_id: string }>;
    const entries: GroupSummaryPolicyScopeHandleCatalogEntry[] = [];
    for (const row of rows.slice(0, MAX_GROUP_SUMMARY_POLICY_SCOPE_CATALOG_ENTRIES)) {
      const scope: GroupSummaryPolicyScope = {
        kind: 'group',
        groupId: row.group_id,
      };
      const issued = await issueHandle(scope);
      entries.push({
        fingerprint: this.governanceReference(
          'group-summary-policy-scope',
          JSON.stringify(scope),
        ),
        scopeKind: 'group',
        label: 'Group summary policy',
        handle: issued.handle,
        expiresAt: issued.expiresAt,
      });
    }
    return {
      entries,
      truncated: rows.length > MAX_GROUP_SUMMARY_POLICY_SCOPE_CATALOG_ENTRIES,
    };
  }

  async listExplainConversationScopeHandles(
    issueHandle: ExplainConversationScopeHandleIssuer,
  ): Promise<ExplainConversationScopeHandleCatalog> {
    const rows = this.db.prepare(
      `WITH trim_characters(value) AS (
         VALUES (
           ' ' || char(
             160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
             8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279
           )
         )
       ), valid_traces AS (
         SELECT traces.conversation_id,
                traces.conversation_type,
                traces.group_id,
                traces.created_at
           FROM context_traces traces
           JOIN agent_turns turns
             ON turns.id = traces.turn_id
            AND turns.conversation_id = traces.conversation_id
          WHERE traces.conversation_type IN ('private', 'group')
            AND typeof(traces.conversation_id) = 'text'
            AND length(traces.conversation_id) BETWEEN 1 AND 256
            AND traces.conversation_id = trim(
              traces.conversation_id,
              (SELECT value FROM trim_characters)
            )
            AND instr(traces.conversation_id, char(0)) = 0
            AND traces.conversation_id NOT GLOB
              ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
            AND (
              (traces.conversation_type = 'private' AND traces.group_id IS NULL)
              OR (
                traces.conversation_type = 'group'
                AND typeof(traces.group_id) = 'text'
                AND length(traces.group_id) BETWEEN 1 AND 256
                AND traces.group_id = trim(
                  traces.group_id,
                  (SELECT value FROM trim_characters)
                )
                AND instr(traces.group_id, char(0)) = 0
                AND traces.group_id NOT GLOB
                  ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
              )
            )
       ), normalized_scopes AS (
         SELECT conversation_id,
                conversation_type,
                group_id,
                MAX(created_at) AS latest_created_at
           FROM valid_traces
          GROUP BY conversation_id, conversation_type, group_id
       )
       SELECT conversation_id, conversation_type, group_id, latest_created_at
         FROM normalized_scopes
        ORDER BY latest_created_at DESC,
                 CASE conversation_type WHEN 'private' THEN 0 ELSE 1 END,
                 conversation_id ASC,
                 COALESCE(group_id, '') ASC
        LIMIT ?`,
    ).all(
      MAX_EXPLAIN_CONVERSATION_SCOPE_CATALOG_ENTRIES + 1,
    ) as ExplainConversationScopeRow[];
    const entries: ExplainConversationScopeHandleCatalogEntry[] = [];
    for (const row of rows.slice(0, MAX_EXPLAIN_CONVERSATION_SCOPE_CATALOG_ENTRIES)) {
      const scope: ExplainConversationScope = row.conversation_type === 'private'
        ? {
          kind: 'conversation',
          conversationId: row.conversation_id,
          conversationType: 'private',
        }
        : {
          kind: 'conversation',
          conversationId: row.conversation_id,
          conversationType: 'group',
          groupId: row.group_id,
        };
      const issued = await issueHandle(scope);
      entries.push({
        fingerprint: this.governanceReference(
          'explain-conversation-scope',
          JSON.stringify(scope),
        ),
        scopeKind: 'conversation',
        conversationType: scope.conversationType,
        label: scope.conversationType === 'private'
          ? 'Private conversation'
          : 'Group conversation',
        handle: issued.handle,
        expiresAt: issued.expiresAt,
      });
    }
    return {
      entries,
      truncated: rows.length > MAX_EXPLAIN_CONVERSATION_SCOPE_CATALOG_ENTRIES,
    };
  }

  async listExplainTurnsForScope(
    inputScope: GovernanceQueryScope,
  ): Promise<ExplainTurnScopeInspectionPage> {
    const page = this.selectExplainTurnScopeRows(inputScope);
    if (!page) {
      return { entries: [], truncated: false };
    }
    return {
      entries: page.rows.map((row) => this.explainTurnScopeRowToInspection(row)),
      truncated: page.truncated,
    };
  }

  async listExplainTurnResourceHandlePage(
    inputScope: GovernanceQueryScope,
    issueHandle: ExplainTurnResourceHandleIssuer,
  ): Promise<ExplainTurnResourceHandlePage> {
    const page = this.selectExplainTurnScopeRows(inputScope);
    if (!page) {
      return { entries: [], truncated: false };
    }
    const entries: ExplainTurnResourceHandleInspectionRecord[] = [];
    for (const row of page.rows) {
      const issued = await issueHandle({ scope: page.scope, turnId: row.id });
      entries.push({
        ...this.explainTurnScopeRowToInspection(row),
        handle: issued.handle,
        handleExpiresAt: issued.expiresAt,
      });
    }
    return { entries, truncated: page.truncated };
  }

  async getExplainTurnDetailForScope(input: {
    scope: GovernanceQueryScope;
    turnId: string;
  }): Promise<ExplainTurnDetailInspectionRecord | null> {
    const scope = this.explainConversationScope(input.scope);
    if (!scope || !this.isExplainScopeIdentifier(input.turnId)) {
      return null;
    }
    const groupPredicate = scope.conversationType === 'private'
      ? 'traces.group_id IS NULL'
      : "typeof(traces.group_id) = 'text' AND traces.group_id = ?";
    const authorityGroupPredicate = scope.conversationType === 'private'
      ? 'authority.group_id IS NULL'
      : "typeof(authority.group_id) = 'text' AND authority.group_id = ?";
    const row = this.db.prepare(
      `SELECT turns.id,
              turns.status,
              turns.started_at,
              turns.completed_at,
              turns.action_decision_id,
              traces.id AS trace_id,
              traces.token_budget,
              CASE WHEN json_valid(traces.candidate_memory_ids)
                THEN CASE WHEN json_type(traces.candidate_memory_ids) = 'array'
                  THEN json_array_length(traces.candidate_memory_ids) ELSE 0 END
                ELSE 0
              END AS candidate_memory_count,
              CASE WHEN json_valid(traces.selected_memory_ids)
                THEN CASE WHEN json_type(traces.selected_memory_ids) = 'array'
                  THEN json_array_length(traces.selected_memory_ids) ELSE 0 END
                ELSE 0
              END AS selected_memory_count,
              CASE WHEN json_valid(traces.rejected_memories)
                THEN CASE WHEN json_type(traces.rejected_memories) = 'array'
                  THEN json_array_length(traces.rejected_memories) ELSE 0 END
                ELSE 0
              END AS rejected_memory_count,
              CASE WHEN json_valid(traces.recent_message_ids)
                THEN CASE WHEN json_type(traces.recent_message_ids) = 'array'
                  THEN json_array_length(traces.recent_message_ids) ELSE 0 END
                ELSE 0
              END AS recent_message_count,
              CASE WHEN json_valid(traces.memories)
                THEN CASE WHEN json_type(traces.memories) = 'array'
                  THEN json_array_length(traces.memories) ELSE 0 END
                ELSE 0
              END AS included_memory_count
         FROM agent_turns turns
         JOIN context_traces traces
           ON traces.turn_id = turns.id
          AND traces.conversation_id = turns.conversation_id
        WHERE turns.id = ?
          AND turns.conversation_id = ?
          AND turns.status IN ('pending', 'running', 'completed', 'failed', 'aborted')
          AND typeof(turns.started_at) = 'integer'
          AND turns.started_at BETWEEN ? AND ?
          AND (
            turns.completed_at IS NULL
            OR (
              typeof(turns.completed_at) = 'integer'
              AND turns.completed_at BETWEEN ? AND ?
            )
          )
          AND traces.conversation_id = ?
          AND traces.conversation_type = ?
          AND ${groupPredicate}
          AND EXISTS (
            SELECT 1
              FROM context_traces authority
             WHERE authority.id = turns.context_pack_id
               AND authority.turn_id = turns.id
               AND authority.conversation_id = turns.conversation_id
               AND authority.conversation_id = ?
               AND authority.conversation_type = ?
               AND ${authorityGroupPredicate}
          )
        ORDER BY traces.created_at DESC, traces.id DESC
        LIMIT 1`,
    ).get(
      input.turnId,
      scope.conversationId,
      -MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      -MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      scope.conversationId,
      scope.conversationType,
      ...(scope.conversationType === 'group' ? [scope.groupId] : []),
      scope.conversationId,
      scope.conversationType,
      ...(scope.conversationType === 'group' ? [scope.groupId] : []),
    ) as ExplainTurnDetailBaseRow | undefined;
    if (!row) {
      return null;
    }

    const filters = this.selectExplainTurnDetailLabels(row.trace_id, 'filters_applied');
    const injectedIdentityFields = this.selectExplainTurnDetailLabels(
      row.trace_id,
      'injected_identity_fields',
    );
    const tokenBudget = this.projectExplainTurnDetailTokenBudget(row.token_budget);
    const actionDecision = this.selectExplainTurnActionDecisionDetail(
      row.id,
      row.action_decision_id,
    );
    const tools = this.selectExplainTurnToolDetails(row.id);

    return {
      turn: this.explainTurnScopeRowToInspection(row),
      context: {
        traceSource: 'stored',
        candidateMemoryCount: row.candidate_memory_count,
        selectedMemoryCount: row.selected_memory_count,
        rejectedMemoryCount: row.rejected_memory_count,
        recentMessageCount: row.recent_message_count,
        includedMemoryCount: row.included_memory_count,
        filters: filters.entries,
        filtersTruncated: filters.truncated,
        injectedIdentityFields: injectedIdentityFields.entries,
        injectedIdentityFieldsTruncated: injectedIdentityFields.truncated,
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
      },
      ...(actionDecision === undefined ? {} : { actionDecision }),
      tools: tools.entries,
      toolsTruncated: tools.truncated,
    };
  }

  private selectExplainTurnDetailLabels(
    traceId: string,
    column: 'filters_applied' | 'injected_identity_fields',
  ): {
    entries: ExplainTurnDetailLabelInspectionRecord[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `SELECT items.value AS label
         FROM context_traces traces,
              json_each(
                CASE WHEN json_valid(traces.${column})
                  THEN CASE WHEN json_type(traces.${column}) = 'array'
                    THEN traces.${column} ELSE '[]' END
                  ELSE '[]'
                END
              ) items
        WHERE traces.id = ?
          AND items.type = 'text'
        ORDER BY CAST(items.key AS INTEGER) ASC
        LIMIT ?`,
    ).all(traceId, MAX_EXPLAIN_TURN_DETAIL_ITEMS + 1) as ExplainTurnDetailLabelRow[];
    return {
      entries: rows.slice(0, MAX_EXPLAIN_TURN_DETAIL_ITEMS).map((row) => {
        const label = this.projectExplainTurnDetailText(row.label);
        return {
          label: label.text,
          redacted: label.redacted,
          truncated: label.truncated,
        };
      }),
      truncated: rows.length > MAX_EXPLAIN_TURN_DETAIL_ITEMS,
    };
  }

  private projectExplainTurnDetailTokenBudget(
    raw: string,
  ): ExplainTurnDetailTokenBudgetInspectionRecord | undefined {
    const parsed = this.parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const budget = parsed as Record<string, unknown>;
    const breakdownValue = budget.breakdown;
    if (
      !breakdownValue
      || typeof breakdownValue !== 'object'
      || Array.isArray(breakdownValue)
    ) {
      return undefined;
    }
    const breakdown = breakdownValue as Record<string, unknown>;
    const isTokenCount = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (
      !isTokenCount(budget.max)
      || !isTokenCount(budget.used)
      || budget.used > budget.max
      || !isTokenCount(breakdown.recentMessages)
      || !isTokenCount(breakdown.memory)
      || !isTokenCount(breakdown.identity)
      || !isTokenCount(breakdown.system)
    ) {
      return undefined;
    }
    return {
      max: budget.max,
      used: budget.used,
      breakdown: {
        recentMessages: breakdown.recentMessages,
        memory: breakdown.memory,
        identity: breakdown.identity,
        system: breakdown.system,
      },
    };
  }

  private selectExplainTurnActionDecisionDetail(
    turnId: string,
    linkedDecisionId: string | null,
  ): ExplainTurnActionDecisionDetailInspectionRecord | undefined {
    const row = this.db.prepare(
      `SELECT decisions.id,
              decisions.decided_by,
              decisions.risk_level,
              decisions.confidence,
              decisions.evaluator_required,
              decisions.evaluator_passed,
              CASE WHEN json_valid(decisions.actions)
                THEN CASE WHEN json_type(decisions.actions) = 'array'
                  THEN json_array_length(decisions.actions) ELSE 0 END
                ELSE 0
              END AS action_count,
              CASE WHEN decisions.reasons IS NOT NULL AND json_valid(decisions.reasons)
                THEN CASE WHEN json_type(decisions.reasons) = 'array'
                  THEN json_array_length(decisions.reasons) ELSE 0 END
                ELSE 0
              END AS reason_count,
              CASE WHEN decisions.suppressors IS NOT NULL
                        AND json_valid(decisions.suppressors)
                THEN CASE WHEN json_type(decisions.suppressors) = 'array'
                  THEN json_array_length(decisions.suppressors) ELSE 0 END
                ELSE 0
              END AS suppressor_count
         FROM action_decisions decisions
        WHERE decisions.turn_id = ?
        ORDER BY CASE WHEN decisions.id = ? THEN 0 ELSE 1 END,
                 decisions.created_at DESC,
                 decisions.id DESC
        LIMIT 1`,
    ).get(turnId, linkedDecisionId) as ExplainTurnDetailActionDecisionRow | undefined;
    if (!row || !Number.isFinite(row.confidence)) {
      return undefined;
    }

    const actionTypes = this.selectExplainTurnActionTypes(row.id);
    const executions = this.selectExplainTurnExecutionDetails(row.id);
    return {
      decidedBy: row.decided_by,
      riskLevel: row.risk_level,
      confidence: row.confidence,
      evaluatorRequired: Boolean(row.evaluator_required),
      ...(row.evaluator_passed === null
        ? {}
        : { evaluatorPassed: Boolean(row.evaluator_passed) }),
      actionCount: row.action_count,
      actionTypes: actionTypes.entries,
      actionTypesTruncated: actionTypes.truncated,
      reasonCount: row.reason_count,
      suppressorCount: row.suppressor_count,
      executions: executions.entries,
      executionsTruncated: executions.truncated,
    };
  }

  private selectExplainTurnActionTypes(decisionId: string): {
    entries: ExplainTurnDetailActionType[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `SELECT CASE WHEN items.type = 'object'
                THEN CASE WHEN json_type(items.value, '$.type') = 'text'
                  THEN json_extract(items.value, '$.type') ELSE NULL END
                ELSE NULL
              END AS action_type
         FROM action_decisions decisions,
              json_each(
                CASE WHEN json_valid(decisions.actions)
                  THEN CASE WHEN json_type(decisions.actions) = 'array'
                    THEN decisions.actions ELSE '[]' END
                  ELSE '[]'
                END
              ) items
        WHERE decisions.id = ?
        ORDER BY CAST(items.key AS INTEGER) ASC
        LIMIT ?`,
    ).all(decisionId, MAX_EXPLAIN_TURN_DETAIL_ITEMS + 1) as ExplainTurnDetailActionTypeRow[];
    return {
      entries: rows
        .slice(0, MAX_EXPLAIN_TURN_DETAIL_ITEMS)
        .map((row) => this.normalizeExplainTurnDetailActionType(row.action_type)),
      truncated: rows.length > MAX_EXPLAIN_TURN_DETAIL_ITEMS,
    };
  }

  private selectExplainTurnExecutionDetails(decisionId: string): {
    entries: ExplainTurnExecutionDetailInspectionRecord[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `SELECT action_type,
              status,
              executed_message_id IS NOT NULL AS executed_message,
              executed_memory_id IS NOT NULL AS executed_memory,
              executed_job_id IS NOT NULL AS scheduled_job,
              downgraded_from,
              error_code,
              executed_at
         FROM action_executions
        WHERE action_decision_id = ?
          AND typeof(executed_at) = 'integer'
          AND executed_at BETWEEN ? AND ?
        ORDER BY executed_at ASC, id ASC
        LIMIT ?`,
    ).all(
      decisionId,
      -MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      MAX_EXPLAIN_TURN_DETAIL_ITEMS + 1,
    ) as ExplainTurnDetailExecutionRow[];
    return {
      entries: rows.slice(0, MAX_EXPLAIN_TURN_DETAIL_ITEMS).map((row) => {
        const actionType = this.normalizeExplainTurnDetailActionType(row.action_type);
        const errorCode = row.error_code === null
          ? undefined
          : this.projectExplainTurnDetailText(row.error_code);
        const effect = describeGovernanceActionExecutionEffect({
          actionType,
          status: row.status,
          executedMessageId: row.executed_message ? 'present' : undefined,
        });
        return {
          actionType,
          status: row.status,
          ...(effect === undefined ? {} : { effect }),
          executedMessage: Boolean(row.executed_message),
          executedMemory: Boolean(row.executed_memory),
          scheduledJob: Boolean(row.scheduled_job),
          ...(row.downgraded_from === null
            ? {}
            : {
              downgradedFrom: this.normalizeExplainTurnDetailActionType(
                row.downgraded_from,
              ),
            }),
          ...(errorCode === undefined ? {} : { errorCode: errorCode.text }),
          errorCodeRedacted: errorCode?.redacted ?? false,
          errorCodeTruncated: errorCode?.truncated ?? false,
          executedAt: new Date(row.executed_at),
        };
      }),
      truncated: rows.length > MAX_EXPLAIN_TURN_DETAIL_ITEMS,
    };
  }

  private selectExplainTurnToolDetails(turnId: string): {
    entries: ExplainTurnToolDetailInspectionRecord[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `SELECT tool_name,
              requested_by,
              status,
              error_code,
              execution_time_ms,
              secrets_redacted,
              created_at
         FROM tool_calls
        WHERE turn_id = ?
          AND typeof(created_at) = 'integer'
          AND created_at BETWEEN ? AND ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).all(
      turnId,
      -MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      MAX_EXPLAIN_TURN_DETAIL_ITEMS + 1,
    ) as ExplainTurnDetailToolRow[];
    return {
      entries: rows.slice(0, MAX_EXPLAIN_TURN_DETAIL_ITEMS).map((row) => {
        const toolName = this.projectExplainTurnDetailText(row.tool_name);
        const errorCode = row.error_code === null
          ? undefined
          : this.projectExplainTurnDetailText(row.error_code);
        const executionTimeMs = row.execution_time_ms !== null
          && Number.isSafeInteger(row.execution_time_ms)
          && row.execution_time_ms >= 0
          ? row.execution_time_ms
          : undefined;
        return {
          toolName: toolName.text,
          toolNameRedacted: toolName.redacted,
          toolNameTruncated: toolName.truncated,
          requestedBy: row.requested_by,
          status: row.status,
          ...(errorCode === undefined ? {} : { errorCode: errorCode.text }),
          errorCodeRedacted: errorCode?.redacted ?? false,
          errorCodeTruncated: errorCode?.truncated ?? false,
          ...(executionTimeMs === undefined ? {} : { executionTimeMs }),
          secretsRedacted: Boolean(row.secrets_redacted)
            || toolName.redacted
            || Boolean(errorCode?.redacted),
          createdAt: new Date(row.created_at),
        };
      }),
      truncated: rows.length > MAX_EXPLAIN_TURN_DETAIL_ITEMS,
    };
  }

  private normalizeExplainTurnDetailActionType(value: unknown): ExplainTurnDetailActionType {
    return typeof value === 'string'
      ? EXPLAIN_ACTION_TYPES.find((candidate) => candidate === value) ?? 'other'
      : 'other';
  }

  private projectExplainTurnDetailText(text: string): {
    text: string;
    redacted: boolean;
    truncated: boolean;
  } {
    const projected = projectBoundedGovernanceText(
      text,
      MAX_EXPLAIN_TURN_DETAIL_LABEL_CODE_POINTS,
    );
    return {
      ...projected,
      truncated: projected.truncated
        || Array.from(text).length > MAX_EXPLAIN_TURN_DETAIL_LABEL_CODE_POINTS,
    };
  }

  private selectExplainTurnScopeRows(
    inputScope: GovernanceQueryScope,
  ): {
    scope: ExplainConversationScope;
    rows: ExplainTurnScopeRow[];
    truncated: boolean;
  } | null {
    const scope = this.explainConversationScope(inputScope);
    if (!scope) {
      return null;
    }
    const groupPredicate = scope.conversationType === 'private'
      ? 'traces.group_id IS NULL'
      : "typeof(traces.group_id) = 'text' AND traces.group_id = ?";
    const params: unknown[] = [
      scope.conversationId,
      -MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      -MAX_JAVASCRIPT_DATE_MS,
      MAX_JAVASCRIPT_DATE_MS,
      scope.conversationId,
      scope.conversationType,
      ...(scope.conversationType === 'group' ? [scope.groupId] : []),
      MAX_EXPLAIN_TURN_PAGE_ENTRIES + 1,
    ];
    const candidateRows = this.db.prepare(
      `WITH trim_characters(value) AS (
         VALUES (
           ' ' || char(
             160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
             8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279
           )
         )
       )
       SELECT turns.id, turns.status, turns.started_at, turns.completed_at
         FROM agent_turns turns
        WHERE typeof(turns.id) = 'text'
          AND length(turns.id) BETWEEN 1 AND 256
          AND turns.id = trim(turns.id, (SELECT value FROM trim_characters))
          AND instr(turns.id, char(0)) = 0
          AND turns.id NOT GLOB
            ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
          AND turns.conversation_id = ?
          AND turns.status IN ('pending', 'running', 'completed', 'failed', 'aborted')
          AND typeof(turns.started_at) = 'integer'
          AND turns.started_at BETWEEN ? AND ?
          AND (
            turns.completed_at IS NULL
            OR (
              typeof(turns.completed_at) = 'integer'
              AND turns.completed_at BETWEEN ? AND ?
            )
          )
          AND EXISTS (
            SELECT 1
              FROM context_traces traces
             WHERE traces.turn_id = turns.id
               AND traces.conversation_id = turns.conversation_id
               AND traces.conversation_id = ?
               AND traces.conversation_type = ?
               AND ${groupPredicate}
          )
        ORDER BY turns.started_at DESC, turns.id DESC
        LIMIT ?`,
    ).all(...params) as ExplainTurnScopeRow[];
    return {
      scope,
      rows: candidateRows.slice(0, MAX_EXPLAIN_TURN_PAGE_ENTRIES),
      truncated: candidateRows.length > MAX_EXPLAIN_TURN_PAGE_ENTRIES,
    };
  }

  private explainTurnScopeRowToInspection(
    row: ExplainTurnScopeRow,
  ): ExplainTurnScopeInspectionRecord {
    return {
      fingerprint: this.governanceReference('explain-turn', row.id),
      label: 'Turn',
      traceSource: 'stored',
      status: row.status,
      startedAt: new Date(row.started_at),
      ...(row.completed_at === null
        ? {}
        : { completedAt: new Date(row.completed_at) }),
    };
  }

  private readMemoryMaintenanceReviewScopeRows(): {
    rows: GovernanceExactScopeRow[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `WITH normalized_scopes AS (
         SELECT scope,
                CASE WHEN scope = 'user' THEN canonical_user_id ELSE NULL END
                  AS canonical_user_id,
                CASE WHEN scope IN ('group', 'conversation') THEN group_id ELSE NULL END
                  AS group_id,
                CASE WHEN scope = 'conversation' THEN conversation_id ELSE NULL END
                  AS conversation_id
           FROM memory_maintenance_proposals
          WHERE scope IN ('global', 'user', 'group', 'conversation', 'system')
       )
       SELECT scope, canonical_user_id, group_id, conversation_id
         FROM normalized_scopes
        GROUP BY scope, canonical_user_id, group_id, conversation_id
        ORDER BY CASE scope
                   WHEN 'global' THEN 0
                   WHEN 'user' THEN 1
                   WHEN 'group' THEN 2
                   WHEN 'conversation' THEN 3
                   WHEN 'system' THEN 4
                 END,
                 CASE WHEN scope = 'conversation' AND group_id IS NULL THEN 0 ELSE 1 END,
                 COALESCE(canonical_user_id, ''),
                 COALESCE(group_id, ''),
                 COALESCE(conversation_id, '')
        LIMIT ?`,
    ).all(MAX_MEMORY_MAINTENANCE_SCOPE_CATALOG_ENTRIES + 1) as GovernanceExactScopeRow[];
    return {
      rows: rows.slice(0, MAX_MEMORY_MAINTENANCE_SCOPE_CATALOG_ENTRIES),
      truncated: rows.length > MAX_MEMORY_MAINTENANCE_SCOPE_CATALOG_ENTRIES,
    };
  }

  private readMemoryRecordScopeRows(): {
    rows: GovernanceExactScopeRow[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `WITH trim_characters(value) AS (
         VALUES (
           ' ' || char(
             160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
             8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279
           )
         )
       ), normalized_scopes AS (
         SELECT scope,
                CASE WHEN scope = 'user' THEN canonical_user_id ELSE NULL END
                  AS canonical_user_id,
                CASE WHEN scope IN ('group', 'conversation') THEN group_id ELSE NULL END
                  AS group_id,
                CASE WHEN scope = 'conversation' THEN conversation_id ELSE NULL END
                  AS conversation_id
           FROM memory_records
          WHERE scope IN ('global', 'user', 'group', 'conversation', 'system')
            AND CASE scope
                  WHEN 'global' THEN 1
                  WHEN 'system' THEN 1
                  WHEN 'user' THEN
                    typeof(canonical_user_id) = 'text'
                    AND length(canonical_user_id) BETWEEN 1 AND 256
                    AND canonical_user_id = trim(
                      canonical_user_id,
                      (SELECT value FROM trim_characters)
                    )
                    AND instr(canonical_user_id, char(0)) = 0
                    AND canonical_user_id NOT GLOB
                      ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
                  WHEN 'group' THEN
                    typeof(group_id) = 'text'
                    AND length(group_id) BETWEEN 1 AND 256
                    AND group_id = trim(group_id, (SELECT value FROM trim_characters))
                    AND instr(group_id, char(0)) = 0
                    AND group_id NOT GLOB
                      ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
                  WHEN 'conversation' THEN
                    typeof(conversation_id) = 'text'
                    AND length(conversation_id) BETWEEN 1 AND 256
                    AND conversation_id = trim(
                      conversation_id,
                      (SELECT value FROM trim_characters)
                    )
                    AND instr(conversation_id, char(0)) = 0
                    AND conversation_id NOT GLOB
                      ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
                    AND (
                      group_id IS NULL
                      OR (
                        typeof(group_id) = 'text'
                        AND length(group_id) BETWEEN 1 AND 256
                        AND group_id = trim(group_id, (SELECT value FROM trim_characters))
                        AND instr(group_id, char(0)) = 0
                        AND group_id NOT GLOB
                          ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
                      )
                    )
                END
       )
       SELECT scope, canonical_user_id, group_id, conversation_id
         FROM normalized_scopes
        GROUP BY scope, canonical_user_id, group_id, conversation_id
        ORDER BY CASE scope
                   WHEN 'global' THEN 0
                   WHEN 'user' THEN 1
                   WHEN 'group' THEN 2
                   WHEN 'conversation' THEN 3
                   WHEN 'system' THEN 4
                 END,
                 CASE WHEN scope = 'conversation' AND group_id IS NULL THEN 0 ELSE 1 END,
                 COALESCE(canonical_user_id, ''),
                 COALESCE(group_id, ''),
                 COALESCE(conversation_id, '')
        LIMIT ?`,
    ).all(MAX_MEMORY_RECORD_SCOPE_CATALOG_ENTRIES + 1) as GovernanceExactScopeRow[];
    return {
      rows: rows.slice(0, MAX_MEMORY_RECORD_SCOPE_CATALOG_ENTRIES),
      truncated: rows.length > MAX_MEMORY_RECORD_SCOPE_CATALOG_ENTRIES,
    };
  }

  async listMemoryMaintenanceReviews(
    options: ListMemoryMaintenanceReviewsOptions,
  ): Promise<MemoryMaintenanceReviewInspectionRecord[]> {
    const scope = this.toMemoryMaintenanceExactScope(options.scope);
    if (!scope) {
      return [];
    }
    const proposals = this.maintenanceProposals.listForReview({
      access: { kind: 'exact_scope', scope },
      ...(options.states === undefined ? {} : { states: options.states }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return proposals.map((proposal) => this.memoryMaintenanceReviewToInspection(
      proposal,
      scope.kind,
    ));
  }

  async listMemoryMaintenanceReviewPage(options: {
    scope: GovernanceQueryScope;
    states?: MemoryMaintenanceProposalLifecycleState[];
  }): Promise<MemoryMaintenanceReviewListPage> {
    const scope = this.toMemoryMaintenanceExactScope(options.scope);
    if (!scope) {
      return { entries: [], truncated: false };
    }
    const states = options.states === undefined ? {} : { states: options.states };
    const entries = await this.listMemoryMaintenanceReviews({
      scope,
      ...states,
      limit: MAX_MEMORY_MAINTENANCE_REVIEW_ENTRIES,
    });
    const total = this.maintenanceProposals.countForReview({
      access: { kind: 'exact_scope', scope },
      ...states,
    });
    return {
      entries,
      truncated: total > entries.length,
    };
  }

  async listMemoryMaintenanceReviewResourceHandlePage(
    options: {
      scope: GovernanceQueryScope;
      states?: MemoryMaintenanceProposalLifecycleState[];
    },
    issueHandle: MemoryMaintenanceReviewResourceHandleIssuer,
  ): Promise<MemoryMaintenanceReviewResourceHandlePage> {
    const scope = this.toMemoryMaintenanceExactScope(options.scope);
    if (!scope) {
      return { entries: [], truncated: false };
    }
    const states = options.states === undefined ? {} : { states: options.states };
    const proposals = this.maintenanceProposals.listForReview({
      access: { kind: 'exact_scope', scope },
      ...states,
      limit: MAX_MEMORY_MAINTENANCE_REVIEW_ENTRIES,
    });
    const entries: MemoryMaintenanceReviewResourceHandleInspectionRecord[] = [];
    for (const proposal of proposals) {
      const issued = await issueHandle({ scope, proposalId: proposal.proposalId });
      entries.push({
        ...this.memoryMaintenanceReviewToInspection(proposal, scope.kind),
        handle: issued.handle,
        handleExpiresAt: issued.expiresAt,
      });
    }
    const total = this.maintenanceProposals.countForReview({
      access: { kind: 'exact_scope', scope },
      ...states,
    });
    return { entries, truncated: total > entries.length };
  }

  async getMemoryMaintenanceReview(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
  }): Promise<MemoryMaintenanceReviewDetailInspectionRecord | null> {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    if (!scope) {
      return null;
    }
    const proposal = this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: { kind: 'exact_scope', scope },
    });
    if (!proposal) {
      return null;
    }

    const candidates = proposal.candidates.slice(0, MAX_MEMORY_MAINTENANCE_DETAIL_ITEMS);
    const revisions = proposal.revisions.slice(-MAX_MEMORY_MAINTENANCE_DETAIL_ITEMS);
    return {
      ...this.memoryMaintenanceReviewToInspection(proposal, scope.kind),
      effectMemoryRef: proposal.effectMemoryId
        ? this.governanceReference('memory', proposal.effectMemoryId)
        : undefined,
      effectMemoryRole: proposal.effectMemoryRole,
      candidates: candidates.map((candidate) => ({
        candidateOrdinal: candidate.candidateOrdinal,
        memoryRef: this.governanceReference('memory', candidate.memoryId),
        effectRole: candidate.effectRole,
        expectedState: candidate.expectedState,
        recordFingerprint: candidate.recordFingerprint,
        sourceCount: candidate.sourceCount,
        sourceFingerprint: candidate.sourceFingerprint,
      })),
      candidatesTruncated: proposal.candidates.length > candidates.length,
      revisions: revisions.map((revision) => ({
        revisionNumber: revision.revisionNumber,
        transition: revision.transition,
        previousState: revision.previousState,
        newState: revision.newState,
        actorClass: revision.actorClass,
        invocationContext: revision.invocationContext,
        reasonCode: redactGovernanceDisplayString(revision.reasonCode).text,
        createdAt: new Date(revision.createdAt),
      })),
      revisionsTruncated: proposal.revisions.length > revisions.length,
    };
  }

  async getMemoryMaintenanceApprovalPreview(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
  }): Promise<MemoryMaintenanceApprovalPreviewProjection | null> {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    if (!scope) {
      return null;
    }
    const proposal = this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: { kind: 'exact_scope', scope },
    });
    if (!proposal || proposal.lifecycleState !== 'pending_review') {
      return null;
    }

    const payload: Omit<MemoryMaintenanceApprovalPreviewProjection, 'previewDigest'> = {
      action: MEMORY_MAINTENANCE_APPROVAL_ACTION,
      scope: {
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: scope.kind,
        ...(scope.kind === 'conversation'
          ? { conversationType: scope.conversationType }
          : {}),
      },
      proposalKind: proposal.kind,
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        proposal.proposalId,
      ),
      proposedEffect: proposal.effectType,
      affectedRecords: {
        count: proposal.candidates.length,
        fingerprint: proposal.candidateFingerprint,
      },
      current: {
        lifecycleState: proposal.lifecycleState,
        revisionNumber: proposal.currentRevisionNumber,
      },
      expected: {
        lifecycleState: 'approved',
        revisionNumber: proposal.currentRevisionNumber + 1,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
        ],
        unavailableEffects: ['memory_record_mutation'],
      },
      rollback: {
        supported: false,
        boundary: 'approval_does_not_apply_memory_effects',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_MAINTENANCE_APPROVAL_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async getMemoryMaintenanceRejectionPreview(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
  }): Promise<MemoryMaintenanceRejectionPreviewProjection | null> {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    if (!scope) {
      return null;
    }
    const proposal = this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: { kind: 'exact_scope', scope },
    });
    if (!proposal || proposal.lifecycleState !== 'pending_review') {
      return null;
    }

    const payload: Omit<MemoryMaintenanceRejectionPreviewProjection, 'previewDigest'> = {
      action: MEMORY_MAINTENANCE_REJECTION_ACTION,
      scope: {
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: scope.kind,
        ...(scope.kind === 'conversation'
          ? { conversationType: scope.conversationType }
          : {}),
      },
      proposalKind: proposal.kind,
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        proposal.proposalId,
      ),
      proposedEffect: proposal.effectType,
      affectedRecords: {
        count: proposal.candidates.length,
        fingerprint: proposal.candidateFingerprint,
      },
      current: {
        lifecycleState: proposal.lifecycleState,
        revisionNumber: proposal.currentRevisionNumber,
      },
      expected: {
        lifecycleState: 'rejected',
        revisionNumber: proposal.currentRevisionNumber + 1,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
        ],
        unavailableEffects: ['memory_record_mutation'],
      },
      rollback: {
        supported: false,
        boundary: 'rejection_does_not_apply_memory_effects',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_MAINTENANCE_REJECTION_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async getMemoryMaintenanceExpirationPreview(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
  }): Promise<MemoryMaintenanceExpirationPreviewProjection | null> {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    if (!scope) {
      return null;
    }
    const proposal = this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: { kind: 'exact_scope', scope },
    });
    if (!proposal || proposal.lifecycleState !== 'pending_review') {
      return null;
    }

    const payload: Omit<MemoryMaintenanceExpirationPreviewProjection, 'previewDigest'> = {
      action: MEMORY_MAINTENANCE_EXPIRATION_ACTION,
      scope: {
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: scope.kind,
        ...(scope.kind === 'conversation'
          ? { conversationType: scope.conversationType }
          : {}),
      },
      proposalKind: proposal.kind,
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        proposal.proposalId,
      ),
      proposedEffect: proposal.effectType,
      affectedRecords: {
        count: proposal.candidates.length,
        fingerprint: proposal.candidateFingerprint,
      },
      current: {
        lifecycleState: proposal.lifecycleState,
        revisionNumber: proposal.currentRevisionNumber,
      },
      expected: {
        lifecycleState: 'expired',
        revisionNumber: proposal.currentRevisionNumber + 1,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
        ],
        unavailableEffects: ['memory_record_mutation'],
      },
      rollback: {
        supported: false,
        boundary: 'expiration_does_not_apply_memory_effects',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_MAINTENANCE_EXPIRATION_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async getMemoryMaintenanceApplicationPreview(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
    retainedMemoryRef?: string;
  }): Promise<MemoryMaintenanceApplicationPreviewProjection | null> {
    return (await this.resolveMemoryMaintenanceApplication(input))?.preview ?? null;
  }

  async getMemoryMaintenanceRollbackPreview(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
  }): Promise<MemoryMaintenanceRollbackPreviewProjection | null> {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    if (!scope) {
      return null;
    }
    const proposal = this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: { kind: 'exact_scope', scope },
    });
    if (!proposal || proposal.lifecycleState !== 'applied') {
      return null;
    }

    const memoryRefs = proposal.candidates
      .map((candidate) => this.governanceReference('memory', candidate.memoryId))
      .sort();
    if (memoryRefs.length === 0 || new Set(memoryRefs).size !== memoryRefs.length) {
      return null;
    }
    const payload: Omit<MemoryMaintenanceRollbackPreviewProjection, 'previewDigest'> = {
      action: MEMORY_MAINTENANCE_ROLLBACK_ACTION,
      scope: {
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: scope.kind,
        ...(scope.kind === 'conversation'
          ? { conversationType: scope.conversationType }
          : {}),
      },
      proposalKind: proposal.kind,
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        proposal.proposalId,
      ),
      proposedEffect: proposal.effectType,
      affectedRecords: {
        count: proposal.candidates.length,
        fingerprint: proposal.candidateFingerprint,
        roles: [{
          role: 'restored',
          count: memoryRefs.length,
          fingerprint: this.memoryMaintenanceRollbackRoleFingerprint(memoryRefs),
        }],
      },
      current: {
        lifecycleState: proposal.lifecycleState,
        revisionNumber: proposal.currentRevisionNumber,
      },
      expected: {
        lifecycleState: 'rolled_back',
        revisionNumber: proposal.currentRevisionNumber + 1,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
          'memory_record_revision_append',
          'proposal_effect_evidence_append',
        ],
        retrievalConsequences: ['restored_records_included'],
      },
      confirmation: {
        required: true,
        boundary: 'separate_confirmation_required',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_MAINTENANCE_ROLLBACK_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async resolveMemoryMaintenanceApplication(input: {
    scope: GovernanceQueryScope;
    proposalId: string;
    retainedMemoryRef?: string;
  }): Promise<ResolvedMemoryMaintenanceApplication | null> {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    if (!scope) {
      return null;
    }
    const proposal = this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: { kind: 'exact_scope', scope },
    });
    if (!proposal || proposal.lifecycleState !== 'approved') {
      return null;
    }

    const candidates = proposal.candidates.map((candidate) => ({
      candidate,
      memoryRef: this.governanceReference('memory', candidate.memoryId),
    }));
    if (new Set(candidates.map((candidate) => candidate.memoryRef)).size !== candidates.length) {
      return null;
    }
    const effects: Array<{
      memoryRef: string;
      role: 'retained' | 'superseded' | 'disabled';
    }> = [];
    let retainedMemoryId: string | undefined;
    let selection: MemoryMaintenanceApplicationPreviewProjection['selection'];
    switch (proposal.kind) {
      case 'conflict': {
        const retained = typeof input.retainedMemoryRef === 'string'
          ? candidates
            .slice(0, MAX_MEMORY_MAINTENANCE_DETAIL_ITEMS)
            .filter((candidate) => candidate.memoryRef === input.retainedMemoryRef)
          : [];
        const retainedCandidate = retained[0];
        if (
          proposal.effectType !== 'resolve_conflict'
          || candidates.length < 2
          || candidates.some(({ candidate }) => candidate.effectRole !== 'conflict_candidate')
          || retained.length !== 1
          || !retainedCandidate
        ) {
          return null;
        }
        for (const candidate of candidates) {
          effects.push({
            memoryRef: candidate.memoryRef,
            role: candidate === retainedCandidate ? 'retained' : 'superseded',
          });
        }
        selection = {
          required: true,
          retainedMemoryRef: input.retainedMemoryRef,
        };
        retainedMemoryId = retainedCandidate.candidate.memoryId;
        break;
      }
      case 'consolidation': {
        const retained = candidates.filter(
          ({ candidate }) => candidate.effectRole === 'retained',
        );
        const superseded = candidates.filter(
          ({ candidate }) => candidate.effectRole === 'supersede',
        );
        if (
          input.retainedMemoryRef !== undefined
          || proposal.effectType !== 'consolidate'
          || retained.length !== 1
          || superseded.length < 1
          || retained.length + superseded.length !== candidates.length
          || retained[0]?.candidate.memoryId !== proposal.effectMemoryId
        ) {
          return null;
        }
        for (const candidate of candidates) {
          effects.push({
            memoryRef: candidate.memoryRef,
            role: candidate.candidate.effectRole === 'retained' ? 'retained' : 'superseded',
          });
        }
        selection = { required: false };
        break;
      }
      case 'decay': {
        const target = candidates[0];
        if (
          input.retainedMemoryRef !== undefined
          || proposal.effectType !== 'disable'
          || candidates.length !== 1
          || target?.candidate.effectRole !== 'disable_target'
          || target.candidate.memoryId !== proposal.effectMemoryId
        ) {
          return null;
        }
        effects.push({ memoryRef: target.memoryRef, role: 'disabled' });
        selection = { required: false };
        break;
      }
    }

    const roleOrder = ['retained', 'superseded', 'disabled'] as const;
    const roles: MemoryMaintenanceApplicationPreviewProjection['affectedRecords']['roles'] = [];
    for (const role of roleOrder) {
      const memoryRefs = effects
        .filter((effect) => effect.role === role)
        .map((effect) => effect.memoryRef)
        .sort();
      if (memoryRefs.length > 0) {
        roles.push({
          role,
          count: memoryRefs.length,
          fingerprint: this.memoryMaintenanceApplicationRoleFingerprint(role, memoryRefs),
        });
      }
    }
    const payload: Omit<MemoryMaintenanceApplicationPreviewProjection, 'previewDigest'> = {
      action: MEMORY_MAINTENANCE_APPLICATION_ACTION,
      scope: {
        fingerprint: this.governanceReference(
          'memory-maintenance-scope',
          JSON.stringify(scope),
        ),
        scopeKind: scope.kind,
        ...(scope.kind === 'conversation'
          ? { conversationType: scope.conversationType }
          : {}),
      },
      proposalKind: proposal.kind,
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        proposal.proposalId,
      ),
      proposedEffect: proposal.effectType,
      affectedRecords: {
        count: proposal.candidates.length,
        fingerprint: proposal.candidateFingerprint,
        roles,
      },
      selection,
      current: {
        lifecycleState: proposal.lifecycleState,
        revisionNumber: proposal.currentRevisionNumber,
      },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: proposal.currentRevisionNumber + 1,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
          'memory_record_revision_append',
          'proposal_effect_evidence_append',
        ],
        retrievalConsequences: proposal.kind === 'decay'
          ? ['disabled_records_excluded']
          : ['superseded_records_excluded'],
      },
      rollback: {
        supported: true,
        boundary: 'separate_confirmation_required',
      },
    };
    const preview: MemoryMaintenanceApplicationPreviewProjection = {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_MAINTENANCE_APPLICATION_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
    return {
      preview,
      ...(retainedMemoryId === undefined ? {} : { retainedMemoryId }),
    };
  }

  projectMemoryMaintenanceApplicationConfirmation(input: {
    scope: GovernanceQueryScope;
    proposal: MemoryMaintenanceProposalRecord;
    expectedRevisionNumber: number;
    operation: ResolvedMemoryMaintenanceApplication;
  }): MemoryMaintenanceApplicationConfirmationProjection | null {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    const appliedRevisionNumber = input.expectedRevisionNumber + 1;
    const preview = input.operation.preview;
    const proposalRef = this.governanceReference(
      'memory-maintenance-proposal',
      input.proposal.proposalId,
    );
    const scopeFingerprint = scope
      ? this.governanceReference('memory-maintenance-scope', JSON.stringify(scope))
      : null;
    if (
      !scope
      || !sameMemoryMaintenanceExactScope(scope, input.proposal.scope)
      || !Number.isSafeInteger(input.expectedRevisionNumber)
      || input.expectedRevisionNumber < 1
      || !Number.isSafeInteger(appliedRevisionNumber)
      || input.proposal.lifecycleState !== 'applied'
      || input.proposal.currentRevisionNumber !== appliedRevisionNumber
      || preview.action !== MEMORY_MAINTENANCE_APPLICATION_ACTION
      || preview.scope.scopeKind !== scope.kind
      || preview.scope.fingerprint !== scopeFingerprint
      || preview.proposalRef !== proposalRef
      || preview.proposalKind !== input.proposal.kind
      || preview.proposedEffect !== input.proposal.effectType
      || preview.affectedRecords.count !== input.proposal.candidates.length
      || preview.affectedRecords.fingerprint !== input.proposal.candidateFingerprint
      || preview.current.lifecycleState !== 'approved'
      || preview.current.revisionNumber !== input.expectedRevisionNumber
      || preview.expected.lifecycleState !== 'applied'
      || preview.expected.revisionNumber !== appliedRevisionNumber
    ) {
      return null;
    }
    if (
      input.proposal.kind === 'conflict'
        ? (
          preview.selection.required !== true
          || typeof preview.selection.retainedMemoryRef !== 'string'
          || typeof input.operation.retainedMemoryId !== 'string'
          || preview.selection.retainedMemoryRef !== this.governanceReference(
            'memory',
            input.operation.retainedMemoryId,
          )
          || !input.proposal.candidates.some(
            (candidate) => candidate.memoryId === input.operation.retainedMemoryId,
          )
        )
        : (
          preview.selection.required !== false
          || preview.selection.retainedMemoryRef !== undefined
          || input.operation.retainedMemoryId !== undefined
        )
    ) {
      return null;
    }

    const revision = input.proposal.revisions.find(
      (candidate) => candidate.revisionNumber === appliedRevisionNumber,
    );
    if (
      !revision
      || revision.transition !== 'apply'
      || revision.previousState !== 'approved'
      || revision.newState !== 'applied'
      || revision.actorUserId !== null
      || revision.actorClass !== 'admin'
      || revision.invocationContext !== 'admin_cli'
    ) {
      return null;
    }

    return {
      action: MEMORY_MAINTENANCE_APPLICATION_ACTION,
      outcome: 'applied',
      proposalKind: preview.proposalKind,
      proposalRef,
      proposedEffect: preview.proposedEffect,
      affectedRecords: {
        count: preview.affectedRecords.count,
        fingerprint: preview.affectedRecords.fingerprint,
        roles: preview.affectedRecords.roles.map((role) => ({ ...role })),
      },
      selection: { ...preview.selection },
      current: {
        lifecycleState: input.proposal.lifecycleState,
        revisionNumber: input.proposal.currentRevisionNumber,
      },
      retrievalConsequences: [...preview.expected.retrievalConsequences],
      evidence: {
        transition: revision.transition,
        revisionRef: this.governanceReference(
          'memory-maintenance-proposal-revision',
          revision.revisionId,
        ),
        auditRef: this.governanceReference(
          'memory-maintenance-proposal-audit',
          revision.auditId,
        ),
      },
      rollback: {
        supported: true,
        boundary: 'separate_confirmation_required',
      },
    };
  }

  projectMemoryMaintenanceRollbackConfirmation(input: {
    scope: GovernanceQueryScope;
    proposal: MemoryMaintenanceProposalRecord;
    expectedRevisionNumber: number;
    preview: MemoryMaintenanceRollbackPreviewProjection;
  }): MemoryMaintenanceRollbackConfirmationProjection | null {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    const rolledBackRevisionNumber = input.expectedRevisionNumber + 1;
    const proposalRef = this.governanceReference(
      'memory-maintenance-proposal',
      input.proposal.proposalId,
    );
    const scopeFingerprint = scope
      ? this.governanceReference('memory-maintenance-scope', JSON.stringify(scope))
      : null;
    const memoryRefs = input.proposal.candidates
      .map((candidate) => this.governanceReference('memory', candidate.memoryId))
      .sort();
    const restoredRole = input.preview.affectedRecords.roles[0];
    if (
      !scope
      || !sameMemoryMaintenanceExactScope(scope, input.proposal.scope)
      || !Number.isSafeInteger(input.expectedRevisionNumber)
      || input.expectedRevisionNumber < 1
      || !Number.isSafeInteger(rolledBackRevisionNumber)
      || input.proposal.lifecycleState !== 'rolled_back'
      || input.proposal.currentRevisionNumber !== rolledBackRevisionNumber
      || input.preview.action !== MEMORY_MAINTENANCE_ROLLBACK_ACTION
      || input.preview.scope.scopeKind !== scope.kind
      || input.preview.scope.fingerprint !== scopeFingerprint
      || input.preview.proposalRef !== proposalRef
      || input.preview.proposalKind !== input.proposal.kind
      || input.preview.proposedEffect !== input.proposal.effectType
      || input.preview.affectedRecords.count !== input.proposal.candidates.length
      || input.preview.affectedRecords.fingerprint !== input.proposal.candidateFingerprint
      || input.preview.affectedRecords.roles.length !== 1
      || restoredRole?.role !== 'restored'
      || restoredRole.count !== memoryRefs.length
      || memoryRefs.length === 0
      || new Set(memoryRefs).size !== memoryRefs.length
      || restoredRole.fingerprint
        !== this.memoryMaintenanceRollbackRoleFingerprint(memoryRefs)
      || input.preview.current.lifecycleState !== 'applied'
      || input.preview.current.revisionNumber !== input.expectedRevisionNumber
      || input.preview.expected.lifecycleState !== 'rolled_back'
      || input.preview.expected.revisionNumber !== rolledBackRevisionNumber
      || input.preview.expected.retrievalConsequences.length !== 1
      || input.preview.expected.retrievalConsequences[0] !== 'restored_records_included'
      || input.preview.confirmation.required !== true
      || input.preview.confirmation.boundary !== 'separate_confirmation_required'
    ) {
      return null;
    }

    const revision = input.proposal.revisions.find(
      (candidate) => candidate.revisionNumber === rolledBackRevisionNumber,
    );
    if (
      !revision
      || revision.transition !== 'rollback'
      || revision.previousState !== 'applied'
      || revision.newState !== 'rolled_back'
      || revision.actorUserId !== null
      || revision.actorClass !== 'admin'
      || revision.invocationContext !== 'admin_cli'
    ) {
      return null;
    }

    return {
      action: MEMORY_MAINTENANCE_ROLLBACK_ACTION,
      outcome: 'rolled_back',
      proposalKind: input.preview.proposalKind,
      proposalRef,
      proposedEffect: input.preview.proposedEffect,
      affectedRecords: {
        count: input.preview.affectedRecords.count,
        fingerprint: input.preview.affectedRecords.fingerprint,
        roles: input.preview.affectedRecords.roles.map((role) => ({ ...role })),
      },
      current: {
        lifecycleState: input.proposal.lifecycleState,
        revisionNumber: input.proposal.currentRevisionNumber,
      },
      retrievalConsequences: [...input.preview.expected.retrievalConsequences],
      evidence: {
        transition: revision.transition,
        revisionRef: this.governanceReference(
          'memory-maintenance-proposal-revision',
          revision.revisionId,
        ),
        auditRef: this.governanceReference(
          'memory-maintenance-proposal-audit',
          revision.auditId,
        ),
      },
      rollback: {
        supported: false,
        boundary: 'rollback_is_terminal',
      },
    };
  }

  projectMemoryMaintenanceApprovalConfirmation(input: {
    scope: GovernanceQueryScope;
    proposal: MemoryMaintenanceProposalRecord;
    expectedRevisionNumber: number;
  }): MemoryMaintenanceApprovalConfirmationProjection | null {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    const approvedRevisionNumber = input.expectedRevisionNumber + 1;
    if (
      !scope
      || !sameMemoryMaintenanceExactScope(scope, input.proposal.scope)
      || !Number.isSafeInteger(input.expectedRevisionNumber)
      || input.expectedRevisionNumber < 1
      || !Number.isSafeInteger(approvedRevisionNumber)
      || input.proposal.lifecycleState !== 'approved'
      || input.proposal.currentRevisionNumber !== approvedRevisionNumber
    ) {
      return null;
    }
    const revision = input.proposal.revisions.find(
      (candidate) => candidate.revisionNumber === approvedRevisionNumber,
    );
    if (
      !revision
      || revision.transition !== 'approve'
      || revision.previousState !== 'pending_review'
      || revision.newState !== 'approved'
      || revision.actorUserId !== null
      || revision.actorClass !== 'admin'
      || revision.invocationContext !== 'admin_cli'
    ) {
      return null;
    }

    return {
      action: MEMORY_MAINTENANCE_APPROVAL_ACTION,
      outcome: 'approved',
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        input.proposal.proposalId,
      ),
      current: {
        lifecycleState: input.proposal.lifecycleState,
        revisionNumber: input.proposal.currentRevisionNumber,
      },
      evidence: {
        transition: revision.transition,
        revisionRef: this.governanceReference(
          'memory-maintenance-proposal-revision',
          revision.revisionId,
        ),
        auditRef: this.governanceReference(
          'memory-maintenance-proposal-audit',
          revision.auditId,
        ),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'approval_does_not_apply_memory_effects',
      },
    };
  }

  projectMemoryMaintenanceRejectionConfirmation(input: {
    scope: GovernanceQueryScope;
    proposal: MemoryMaintenanceProposalRecord;
    expectedRevisionNumber: number;
  }): MemoryMaintenanceRejectionConfirmationProjection | null {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    const rejectedRevisionNumber = input.expectedRevisionNumber + 1;
    if (
      !scope
      || !sameMemoryMaintenanceExactScope(scope, input.proposal.scope)
      || !Number.isSafeInteger(input.expectedRevisionNumber)
      || input.expectedRevisionNumber < 1
      || !Number.isSafeInteger(rejectedRevisionNumber)
      || input.proposal.lifecycleState !== 'rejected'
      || input.proposal.currentRevisionNumber !== rejectedRevisionNumber
    ) {
      return null;
    }
    const revision = input.proposal.revisions.find(
      (candidate) => candidate.revisionNumber === rejectedRevisionNumber,
    );
    if (
      !revision
      || revision.transition !== 'reject'
      || revision.previousState !== 'pending_review'
      || revision.newState !== 'rejected'
      || revision.actorUserId !== null
      || revision.actorClass !== 'admin'
      || revision.invocationContext !== 'admin_cli'
    ) {
      return null;
    }

    return {
      action: MEMORY_MAINTENANCE_REJECTION_ACTION,
      outcome: 'rejected',
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        input.proposal.proposalId,
      ),
      current: {
        lifecycleState: input.proposal.lifecycleState,
        revisionNumber: input.proposal.currentRevisionNumber,
      },
      evidence: {
        transition: revision.transition,
        revisionRef: this.governanceReference(
          'memory-maintenance-proposal-revision',
          revision.revisionId,
        ),
        auditRef: this.governanceReference(
          'memory-maintenance-proposal-audit',
          revision.auditId,
        ),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'rejection_does_not_apply_memory_effects',
      },
    };
  }

  projectMemoryMaintenanceExpirationConfirmation(input: {
    scope: GovernanceQueryScope;
    proposal: MemoryMaintenanceProposalRecord;
    expectedRevisionNumber: number;
  }): MemoryMaintenanceExpirationConfirmationProjection | null {
    const scope = this.toMemoryMaintenanceExactScope(input.scope);
    const expiredRevisionNumber = input.expectedRevisionNumber + 1;
    if (
      !scope
      || !sameMemoryMaintenanceExactScope(scope, input.proposal.scope)
      || !Number.isSafeInteger(input.expectedRevisionNumber)
      || input.expectedRevisionNumber < 1
      || !Number.isSafeInteger(expiredRevisionNumber)
      || input.proposal.lifecycleState !== 'expired'
      || input.proposal.currentRevisionNumber !== expiredRevisionNumber
    ) {
      return null;
    }
    const revision = input.proposal.revisions.find(
      (candidate) => candidate.revisionNumber === expiredRevisionNumber,
    );
    if (
      !revision
      || revision.transition !== 'expire'
      || revision.previousState !== 'pending_review'
      || revision.newState !== 'expired'
      || revision.actorUserId !== null
      || revision.actorClass !== 'admin'
      || revision.invocationContext !== 'admin_cli'
    ) {
      return null;
    }

    return {
      action: MEMORY_MAINTENANCE_EXPIRATION_ACTION,
      outcome: 'expired',
      proposalRef: this.governanceReference(
        'memory-maintenance-proposal',
        input.proposal.proposalId,
      ),
      current: {
        lifecycleState: input.proposal.lifecycleState,
        revisionNumber: input.proposal.currentRevisionNumber,
      },
      evidence: {
        transition: revision.transition,
        revisionRef: this.governanceReference(
          'memory-maintenance-proposal-revision',
          revision.revisionId,
        ),
        auditRef: this.governanceReference(
          'memory-maintenance-proposal-audit',
          revision.auditId,
        ),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'expiration_does_not_apply_memory_effects',
      },
    };
  }

  async listMemory(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT DISTINCT mr.id FROM memory_records mr';

    if (options.sourceType || options.sourceId) {
      query += ' JOIN memory_sources ms ON ms.memory_id = mr.id';
    }

    query += ' WHERE 1=1';

    query += ' AND mr.state = ?';
    params.push(options.state ?? 'active');

    if (options.userId) {
      query += ' AND mr.canonical_user_id = ?';
      params.push(options.userId);
    }

    if (options.groupId) {
      query += ' AND mr.group_id = ?';
      params.push(options.groupId);
    }

    if (options.conversationId) {
      query += ' AND mr.conversation_id = ?';
      params.push(options.conversationId);
    }

    if (options.scope) {
      query += ' AND mr.scope = ?';
      params.push(options.scope);
    }

    if (options.sensitivity) {
      query += ' AND mr.sensitivity = ?';
      params.push(options.sensitivity);
    }

    if (options.sourceContext) {
      query += ' AND mr.source_context = ?';
      params.push(options.sourceContext);
    }

    if (options.sourceType) {
      query += ' AND ms.source_type = ?';
      params.push(options.sourceType);
    }

    if (options.sourceId) {
      query += ' AND ms.source_id = ?';
      params.push(options.sourceId);
    }

    query += ' ORDER BY mr.importance DESC, mr.created_at DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as Array<{ id: string }>;
    const memories = await Promise.all(rows.map((row) => this.memories.findById(row.id)));
    return memories.filter((memory): memory is MemoryRecord => memory !== null);
  }

  async listMemoryRecordsForScope(
    scope: GovernanceQueryScope,
  ): Promise<MemoryRecordScopeInspectionPage> {
    const page = this.selectMemoryRecordScopeRows(scope);
    if (!page) {
      return { entries: [], truncated: false };
    }
    return {
      entries: page.rows.map((row) => this.memoryRecordScopeRowToInspection(row)),
      truncated: page.truncated,
    };
  }

  async listMemoryRecordResourceHandlePage(
    scope: GovernanceQueryScope,
    issueHandle: MemoryRecordResourceHandleIssuer,
  ): Promise<MemoryRecordResourceHandlePage> {
    const page = this.selectMemoryRecordScopeRows(scope);
    if (!page) {
      return { entries: [], truncated: false };
    }
    const entries: MemoryRecordResourceHandleInspectionRecord[] = [];
    for (const row of page.rows) {
      const issued = await issueHandle({ scope: page.scope, memoryId: row.id });
      entries.push({
        ...this.memoryRecordScopeRowToInspection(row),
        handle: issued.handle,
        handleExpiresAt: issued.expiresAt,
      });
    }
    return { entries, truncated: page.truncated };
  }

  async getMemoryRecordDetailForScope(input: {
    scope: GovernanceQueryScope;
    memoryId: string;
  }): Promise<MemoryRecordDetailInspectionRecord | null> {
    const predicate = this.memoryRecordExactScopePredicate(input.scope);
    if (
      !predicate
      || input.memoryId.length === 0
      || input.memoryId.length > 256
      || input.memoryId.trim() !== input.memoryId
    ) {
      return null;
    }
    const recordRow = this.db.prepare(
      `SELECT mr.id,
              mr.scope,
              mr.visibility,
              mr.sensitivity,
              mr.authority,
              mr.kind,
              mr.title,
              mr.content,
              mr.state,
              mr.confidence,
              mr.importance,
              mr.created_at,
              mr.updated_at,
              mr.expires_at,
              0 AS source_count,
              0 AS revision_count
         FROM memory_records mr
        WHERE mr.id = ?
          AND ${predicate.sql}
        LIMIT 1`,
    ).get(input.memoryId, ...predicate.params) as MemoryRecordScopeInspectionRow | undefined;
    if (!recordRow) {
      return null;
    }

    const sourceRows = this.db.prepare(
      `SELECT source_type, source_id, source_timestamp, extracted_by,
              resolution_state, COUNT(*) OVER () AS total_count
         FROM memory_sources
        WHERE memory_id = ?
        ORDER BY source_timestamp ASC, source_id ASC
        LIMIT ?`,
    ).all(input.memoryId, MAX_MEMORY_RECORD_DETAIL_ITEMS + 1) as MemoryRecordDetailSourceRow[];
    const revisionRows = this.db.prepare(
      `SELECT id, revision_number, change_type, previous_state, new_state,
              reason, actor, evaluator_decision_id, created_at,
              COUNT(*) OVER () AS total_count
         FROM memory_revisions
        WHERE memory_id = ?
        ORDER BY revision_number ASC, id ASC
        LIMIT ?`,
    ).all(input.memoryId, MAX_MEMORY_RECORD_DETAIL_ITEMS + 1) as MemoryRecordDetailRevisionRow[];
    const auditRows = this.db.prepare(
      `SELECT id, timestamp, level, event_type, summary, risk_level,
              evaluator_decision_id
         FROM audit_log
        WHERE category = 'memory' AND event_id = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?`,
    ).all(input.memoryId, MAX_MEMORY_RECORD_DETAIL_ITEMS + 1) as MemoryRecordDetailAuditRow[];
    const textHidden = recordRow.sensitivity === 'secret'
      || recordRow.sensitivity === 'prohibited';

    return {
      record: this.memoryRecordScopeRowToInspection({
        ...recordRow,
        source_count: sourceRows[0]?.total_count ?? 0,
        revision_count: revisionRows[0]?.total_count ?? 0,
      }),
      sources: sourceRows
        .slice(0, MAX_MEMORY_RECORD_DETAIL_ITEMS)
        .map((row) => this.memoryRecordDetailSourceToInspection(input.memoryId, row)),
      sourcesTruncated: sourceRows.length > MAX_MEMORY_RECORD_DETAIL_ITEMS,
      revisions: revisionRows
        .slice(0, MAX_MEMORY_RECORD_DETAIL_ITEMS)
        .map((row) => this.memoryRecordDetailRevisionToInspection(row, textHidden)),
      revisionsTruncated: revisionRows.length > MAX_MEMORY_RECORD_DETAIL_ITEMS,
      audit: auditRows
        .slice(0, MAX_MEMORY_RECORD_DETAIL_ITEMS)
        .map((row) => this.memoryRecordDetailAuditToInspection(row, textHidden)),
      auditTruncated: auditRows.length > MAX_MEMORY_RECORD_DETAIL_ITEMS,
    };
  }

  async getMemoryRecordForgetPreviewForScope(input: {
    scope: GovernanceQueryScope;
    memoryId: string;
  }): Promise<MemoryRecordForgetPreviewProjection | null> {
    const memoryIdCharacters = Array.from(input.memoryId);
    if (
      input.memoryId.trim() !== input.memoryId
      || memoryIdCharacters.length < 1
      || memoryIdCharacters.length > 256
      || memoryIdCharacters.some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      return null;
    }
    const predicate = this.memoryRecordExactScopePredicate(input.scope);
    if (!predicate) {
      return null;
    }
    const row = this.db.prepare(
      `SELECT mr.id,
              mr.scope,
              mr.state,
              (
                SELECT MAX(revisions.revision_number)
                  FROM memory_revisions revisions
                 WHERE revisions.memory_id = mr.id
              ) AS current_revision_number
         FROM memory_records mr
        WHERE mr.id = ?
          AND ${predicate.sql}
        LIMIT 1`,
    ).get(input.memoryId, ...predicate.params) as MemoryRecordForgetPreviewRow | undefined;
    const lifecycleState = MEMORY_RECORD_STATES.find((state) => state === row?.state);
    const revisionNumber = row?.current_revision_number;
    if (
      !row
      || lifecycleState === undefined
      || lifecycleState === 'deleted'
      || typeof revisionNumber !== 'number'
      || !Number.isSafeInteger(revisionNumber)
      || revisionNumber < 1
      || revisionNumber >= Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }

    const payload: Omit<MemoryRecordForgetPreviewProjection, 'previewDigest'> = {
      action: MEMORY_RECORD_FORGET_ACTION,
      recordRef: this.governanceReference('memory-record-forget', row.id),
      scopeKind: row.scope,
      current: {
        lifecycleState,
        revisionNumber,
      },
      expected: {
        lifecycleState: 'deleted',
        revisionNumber: revisionNumber + 1,
        durableEffects: [
          'memory_record_state_transition',
          'memory_revision_append',
          'audit_event_append',
        ],
        retrievalConsequences: ['deleted_record_excluded'],
      },
      rollback: {
        supported: true,
        boundary: 'separate_restore_confirmation_required',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_RECORD_FORGET_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async getMemoryRecordRestorePreviewForScope(input: {
    scope: GovernanceQueryScope;
    memoryId: string;
  }): Promise<MemoryRecordRestorePreviewProjection | null> {
    const memoryIdCharacters = Array.from(input.memoryId);
    if (
      input.memoryId.trim() !== input.memoryId
      || memoryIdCharacters.length < 1
      || memoryIdCharacters.length > 256
      || memoryIdCharacters.some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      return null;
    }
    const predicate = this.memoryRecordExactScopePredicate(input.scope);
    if (!predicate) {
      return null;
    }
    const row = this.db.prepare(
      `SELECT mr.id,
              mr.scope,
              mr.state,
              (
                SELECT MAX(revisions.revision_number)
                  FROM memory_revisions revisions
                 WHERE revisions.memory_id = mr.id
              ) AS current_revision_number
         FROM memory_records mr
        WHERE mr.id = ?
          AND ${predicate.sql}
        LIMIT 1`,
    ).get(input.memoryId, ...predicate.params) as MemoryRecordRestorePreviewRow | undefined;
    const lifecycleState = RESTORABLE_MEMORY_RECORD_STATES.find(
      (state) => state === row?.state,
    );
    const revisionNumber = row?.current_revision_number;
    if (
      !row
      || lifecycleState === undefined
      || typeof revisionNumber !== 'number'
      || !Number.isSafeInteger(revisionNumber)
      || revisionNumber < 1
      || revisionNumber >= Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }

    const payload: Omit<MemoryRecordRestorePreviewProjection, 'previewDigest'> = {
      action: MEMORY_RECORD_RESTORE_ACTION,
      recordRef: this.governanceReference('memory-record-restore', row.id),
      scopeKind: row.scope,
      current: {
        lifecycleState,
        revisionNumber,
      },
      expected: {
        lifecycleState: 'active',
        revisionNumber: revisionNumber + 1,
        durableEffects: [
          'memory_record_state_transition',
          'memory_revision_append',
          'audit_event_append',
        ],
        retrievalConsequences: ['restored_records_included'],
      },
      rollback: {
        supported: true,
        boundary: 'separate_forget_confirmation_required',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(MEMORY_RECORD_RESTORE_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async exportMemory(options: ListMemoryOptions = {}): Promise<ExportMemoryRecord[]> {
    const memories = await this.listMemory({
      ...options,
      state: options.state ?? 'active',
    });
    return projectGovernanceMemoryExport(memories);
  }

  async showMemory(memoryId: string): Promise<ShowMemoryResult | null> {
    const record = await this.memories.findById(memoryId);
    if (!record) {
      return null;
    }

    const sources = (this.db
      .prepare(
        `SELECT memory_id, source_type, source_id, source_timestamp, extracted_by
         FROM memory_sources
         WHERE memory_id = ?
         ORDER BY source_timestamp ASC, source_id ASC`,
      )
      .all(memoryId) as MemorySourceRow[]).map((row) => ({
      memoryId: redactGovernanceDisplayString(row.memory_id).text,
      sourceType: redactGovernanceDisplayString(row.source_type).text,
      sourceId: redactGovernanceDisplayString(row.source_id).text,
      sourceTimestamp: new Date(row.source_timestamp),
      extractedBy: row.extracted_by
        ? redactGovernanceDisplayString(row.extracted_by).text
        : undefined,
    }));

    const revisions = (this.db
      .prepare(
        `SELECT id, memory_id, revision_number, previous_state, new_state,
                reason, change_type, actor, evaluator_decision_id, created_at
         FROM memory_revisions
         WHERE memory_id = ?
         ORDER BY revision_number ASC`,
      )
      .all(memoryId) as MemoryRevisionRow[]).map((row) => ({
      id: redactGovernanceDisplayString(row.id).text,
      memoryId: redactGovernanceDisplayString(row.memory_id).text,
      revisionNumber: row.revision_number,
      changeType: redactGovernanceDisplayString(row.change_type).text,
      actor: redactGovernanceDisplayString(row.actor).text,
      reason: redactGovernanceDisplayString(row.reason).text,
      evaluatorDecisionId: row.evaluator_decision_id
        ? redactGovernanceDisplayString(row.evaluator_decision_id).text
        : undefined,
      createdAt: new Date(row.created_at),
      previousState: row.previous_state
        ? redactGovernanceStructuredValue(this.parseJson(row.previous_state)).value
        : undefined,
      newState: redactGovernanceStructuredValue(this.parseJson(row.new_state)).value,
    }));

    const audit = await this.listAudit({
      category: 'memory',
      eventId: memoryId,
      includeDetails: false,
      limit: 100,
    });

    return {
      record: redactGovernanceMemoryRecordForDisplay(record),
      sources,
      revisions,
      audit,
    };
  }

  async listAudit(options: ListAuditOptions = {}): Promise<AuditInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM audit_log WHERE 1=1';

    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }

    if (options.level) {
      query += ' AND level = ?';
      params.push(options.level);
    }

    if (options.eventType) {
      query += ' AND event_type = ?';
      params.push(options.eventType);
    }

    if (options.eventId) {
      query += ' AND event_id = ?';
      params.push(options.eventId);
    }

    if (options.userId) {
      query += ' AND actor_user_id = ?';
      params.push(options.userId);
    }

    if (options.riskLevel) {
      query += ' AND risk_level = ?';
      params.push(options.riskLevel);
    }

    if (options.startTime) {
      query += ' AND timestamp >= ?';
      params.push(options.startTime.getTime());
    }

    if (options.endTime) {
      query += ' AND timestamp <= ?';
      params.push(options.endTime.getTime());
    }

    query += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as AuditRow[];
    return rows.map((row) => this.auditRowToInspection(row, Boolean(options.includeDetails)));
  }

  async listMemoryReviewCandidates(
    options: ListMemoryReviewOptions = {},
  ): Promise<MemoryReviewCandidateInspectionRecord[]> {
    const status = options.status ?? 'all';
    const params: unknown[] = [];
    let query = 'SELECT * FROM audit_log WHERE category = ?';
    params.push('memory');

    if (options.eventType) {
      query += ' AND event_type = ?';
      params.push(options.eventType);
    } else {
      query += ' AND event_type IN (?, ?, ?)';
      params.push(
        'memory.conflict.detected',
        'memory.consolidation.candidates_detected',
        'memory.decay.candidates_detected',
      );
    }

    const requestedLimit = options.limit ?? 100;
    if (options.memoryId || status !== 'all') {
      query += ' ORDER BY timestamp DESC, id DESC';
    } else {
      query += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
      params.push(requestedLimit);
    }

    const rows = this.db.prepare(query).all(...params) as AuditRow[];
    const candidates = rows
      .filter((row) => {
        if (!options.memoryId) {
          return true;
        }

        const parsedDetails = row.details ? this.parseJson(row.details) : undefined;
        return collectGovernanceMemoryIdGroups(parsedDetails)
          .some((group) => group.includes(options.memoryId as string));
      })
      .map((row) => this.memoryReviewRowToInspection(row, Boolean(options.includeDetails)))
      .filter((candidate) => status === 'all' || candidate.status === status);

    return candidates.slice(0, options.limit ?? 100);
  }

  async summarizeMemoryReviews(
    options: MemoryReviewSummaryOptions = {},
  ): Promise<MemoryReviewSummaryInspectionRecord> {
    const candidates = await this.listMemoryReviewCandidates({
      ...options,
      includeDetails: false,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const summary = this.createEmptyMemoryReviewSummary(options);

    for (const candidate of candidates) {
      this.addMemoryReviewCandidateToSummary(summary, candidate);
    }

    return summary;
  }

  async summarizeModelInvocations(
    options: SummarizeModelInvocationsOptions = {},
  ): Promise<ModelInvocationSummaryInspectionRecord> {
    const params: unknown[] = [];
    let where = '1 = 1';
    if (options.purpose) {
      where += ' AND purpose = ?';
      params.push(options.purpose);
    }
    if (options.status) {
      where += ' AND status = ?';
      params.push(options.status);
    }

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM model_invocations WHERE ${where}`,
    ).get(...params) as { count: number };
    const byPurpose = this.countBoundedModelInvocationColumn(
      'purpose',
      where,
      params,
      MODEL_INVOCATION_PURPOSES,
    );
    const byStatus = this.countBoundedModelInvocationColumn(
      'status',
      where,
      params,
      MODEL_INVOCATION_STATUSES,
    );
    const usageRow = this.db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed'
           AND tokens_input IS NOT NULL
           AND tokens_output IS NOT NULL
           AND tokens_total IS NOT NULL THEN 1 ELSE 0 END), 0) AS known,
         COALESCE(SUM(CASE WHEN status = 'completed'
           AND (tokens_input IS NULL OR tokens_output IS NULL OR tokens_total IS NULL)
           THEN 1 ELSE 0 END), 0) AS unknown
         FROM model_invocations
        WHERE ${where}`,
    ).get(...params) as { known: number; unknown: number };

    return {
      generatedAt: new Date(),
      filters: {
        ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
        ...(options.status === undefined ? {} : { status: options.status }),
      },
      total: totalRow.count,
      byPurpose,
      byStatus,
      completedKnownUsage: usageRow.known,
      completedUnknownUsage: usageRow.unknown,
      providerLatencyMs: collectModelInvocationLatency(this.db, {
        purpose: options.purpose,
        status: options.status,
      }),
    };
  }

  async listToolCalls(options: ListToolCallOptions = {}): Promise<ToolCallInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM tool_calls WHERE 1=1';

    if (options.turnId) {
      query += ' AND turn_id = ?';
      params.push(options.turnId);
    }

    if (options.toolName) {
      query += ' AND tool_name = ?';
      params.push(options.toolName);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as ToolCallRow[];
    return rows.map((row) => projectGovernanceToolCallInspection(
      row,
      Boolean(options.includePayload),
    ));
  }

  async listActionDecisions(
    options: ListActionDecisionOptions = {},
  ): Promise<ActionDecisionInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM action_decisions WHERE 1=1';

    if (options.turnId) {
      query += ' AND turn_id = ?';
      params.push(options.turnId);
    }

    if (options.decidedBy) {
      query += ' AND decided_by = ?';
      params.push(options.decidedBy);
    }

    if (options.riskLevel) {
      query += ' AND risk_level = ?';
      params.push(options.riskLevel);
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as ActionDecisionRow[];
    return rows.map((row) => projectGovernanceActionDecisionInspection(
      row,
      Boolean(options.includeActions),
    ));
  }

  async listActionExecutions(
    options: ListActionExecutionOptions = {},
  ): Promise<ActionExecutionInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM action_executions WHERE 1=1';

    if (options.actionDecisionId) {
      query += ' AND action_decision_id = ?';
      params.push(options.actionDecisionId);
    }

    if (options.actionType) {
      query += ' AND action_type = ?';
      params.push(options.actionType);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY executed_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as ActionExecutionRow[];
    return rows.map((row) => projectGovernanceActionExecutionInspection(
      row,
      Boolean(options.includeAuditEntry),
    ));
  }

  async listJobs(options: ListJobOptions = {}): Promise<JobInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM jobs WHERE 1=1';

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    if (options.type) {
      query += ' AND type = ?';
      params.push(options.type);
    }

    query += ' ORDER BY scheduled_at ASC, created_at ASC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as JobRow[];
    return rows.map((row) => projectGovernanceJobInspection(
      row,
      Boolean(options.includePayload),
    ));
  }

  async listJobAttempts(
    options: ListJobAttemptOptions = {},
  ): Promise<JobAttemptInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM job_attempts WHERE 1=1';

    if (options.jobId) {
      query += ' AND job_id = ?';
      params.push(options.jobId);
    }

    if (options.workerId) {
      query += ' AND worker_id = ?';
      params.push(options.workerId);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY started_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as JobAttemptRow[];
    return rows.map((row) => projectGovernanceJobAttemptInspection(
      row,
      Boolean(options.includeResult),
    ));
  }

  async listWorkerHeartbeats(
    options: ListWorkerHeartbeatOptions = {},
  ): Promise<WorkerHeartbeatInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM worker_heartbeats WHERE 1=1';

    if (options.workerId) {
      query += ' AND worker_id = ?';
      params.push(options.workerId);
    }

    if (options.workerType) {
      query += ' AND worker_type = ?';
      params.push(options.workerType);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY heartbeat_at DESC, worker_id ASC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as WorkerHeartbeatRow[];
    return rows.map((row) => projectGovernanceWorkerHeartbeatInspection(
      row,
      Boolean(options.includeDetails),
    ));
  }

  async listEventProcessingFailures(
    options: ListEventProcessingFailureOptions = {},
  ): Promise<EventProcessingFailureInspectionRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM event_processing_failures WHERE 1=1';

    if (options.stage) {
      query += ' AND stage = ?';
      params.push(options.stage);
    }

    if (options.rawEventId) {
      query += ' AND raw_event_id = ?';
      params.push(options.rawEventId);
    }

    if (options.turnId) {
      query += ' AND turn_id = ?';
      params.push(options.turnId);
    }

    query += ' ORDER BY occurred_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as EventProcessingFailureRow[];
    return rows.map((row) => projectGovernanceEventProcessingFailureInspection(
      row,
      Boolean(options.includeDetails),
    ));
  }

  async getGroupSummaryPolicyForScope(
    scope: GovernanceQueryScope,
  ): Promise<GroupSummaryPolicyScopeInspection | null> {
    if (!scope || typeof scope !== 'object' || scope.kind !== 'group') {
      return null;
    }
    const groupId = scope.groupId;
    if (typeof groupId !== 'string') {
      return null;
    }
    const characters = Array.from(groupId);
    if (
      groupId.trim() !== groupId
      || characters.length < 1
      || characters.length > 256
      || characters.some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      return null;
    }

    const row = this.db.prepare(
      `SELECT state, generation, eligible_after, created_at, updated_at
         FROM group_summary_policies
        WHERE group_id = ?
        LIMIT 1`,
    ).get(groupId) as GroupSummaryPolicyInspectionRow | undefined;
    if (!row) {
      return {
        state: 'disabled',
        stored: false,
        generation: null,
        eligibleAfter: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    const state = row.state === 'enabled' || row.state === 'disabled'
      ? row.state
      : null;
    const generation = row.generation;
    const eligibleAfter = row.eligible_after;
    const createdAt = row.created_at;
    const updatedAt = row.updated_at;
    if (
      state === null
      || typeof generation !== 'number'
      || !Number.isSafeInteger(generation)
      || generation < 1
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || createdAt > MAX_JAVASCRIPT_DATE_MS
      || typeof updatedAt !== 'number'
      || !Number.isSafeInteger(updatedAt)
      || updatedAt < createdAt
      || updatedAt > MAX_JAVASCRIPT_DATE_MS
      || (state === 'enabled' && (
        typeof eligibleAfter !== 'number'
        || !Number.isSafeInteger(eligibleAfter)
        || eligibleAfter < 0
        || eligibleAfter > MAX_JAVASCRIPT_DATE_MS
      ))
      || (state === 'disabled' && eligibleAfter !== null)
    ) {
      return null;
    }

    return {
      state,
      stored: true,
      generation,
      eligibleAfter: typeof eligibleAfter === 'number' ? new Date(eligibleAfter) : null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    };
  }

  async getGroupSummaryPolicyChangePreviewForScope(input: {
    scope: GovernanceQueryScope;
    targetState: GroupSummaryPolicyScopeInspection['state'];
  }): Promise<GroupSummaryPolicyChangePreviewProjection | null> {
    if (input.targetState !== 'enabled' && input.targetState !== 'disabled') {
      return null;
    }
    const currentPolicy = await this.getGroupSummaryPolicyForScope(input.scope);
    if (
      currentPolicy === null
      || currentPolicy.state === input.targetState
      || (
        currentPolicy.generation !== null
        && currentPolicy.generation >= Number.MAX_SAFE_INTEGER
      )
    ) {
      return null;
    }

    const enabling = input.targetState === 'enabled';
    const payload: Omit<GroupSummaryPolicyChangePreviewProjection, 'previewDigest'> = {
      action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
      current: {
        state: currentPolicy.state,
        stored: currentPolicy.stored,
        version: {
          generation: currentPolicy.generation,
          updatedAt: currentPolicy.updatedAt,
        },
      },
      expected: {
        state: input.targetState,
        generation: (currentPolicy.generation ?? 0) + 1,
        durableEffects: enabling
          ? ['group_summary_policy_upsert', 'audit_event_append']
          : [
            'group_summary_policy_upsert',
            'pending_group_summary_jobs_terminalized',
            'audit_event_append',
          ],
        enforcementConsequences: enabling
          ? [
            'policy_generation_advanced',
            'pre_enable_sources_excluded',
            'group_summary_generation_and_retrieval_enabled',
          ]
          : [
            'policy_generation_advanced',
            'group_summary_generation_and_retrieval_disabled',
            'pending_group_summary_jobs_canceled',
          ],
      },
      rollback: {
        supported: true,
        targetState: currentPolicy.state,
        boundary: 'separate_group_summary_policy_change_confirmation_required',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(GROUP_SUMMARY_POLICY_CHANGE_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async listPrivacyPreferences(
    options: ListPrivacyPreferenceOptions = {},
  ): Promise<PrivacyPreferenceInspectionRecord[]> {
    return new PrivacyPreferenceRepository(this.db)
      .list(options)
      .map(projectGovernancePrivacyPreferenceInspection);
  }

  async listPrivacyPreferencesForScope(
    scope: GovernanceQueryScope,
  ): Promise<PrivacyPreferenceScopeInspectionPage> {
    if (scope.kind !== 'user') {
      return { entries: [], truncated: false };
    }
    const preferences = await this.listPrivacyPreferences({
      canonicalUserId: scope.canonicalUserId,
      limit: MAX_PRIVACY_PREFERENCE_ENTRIES + 1,
    });
    return {
      entries: preferences
        .slice(0, MAX_PRIVACY_PREFERENCE_ENTRIES)
        .map(projectGovernancePrivacyPreferenceScopeInspection),
      truncated: preferences.length > MAX_PRIVACY_PREFERENCE_ENTRIES,
    };
  }

  async getPrivacyPreferenceChangePreviewForScope(input: {
    scope: GovernanceQueryScope;
    preferenceType: PrivacyPreferenceType;
    targetState: PrivacyPreferenceState;
  }): Promise<PrivacyPreferenceChangePreviewProjection | null> {
    const preferenceType = PRIVACY_PREFERENCE_TYPES.find(
      (candidate) => candidate === input.preferenceType,
    );
    const targetState = PRIVACY_PREFERENCE_STATES.find(
      (candidate) => candidate === input.targetState,
    );
    if (input.scope.kind !== 'user' || !preferenceType || !targetState) {
      return null;
    }
    const canonicalUserId = input.scope.canonicalUserId;
    const userIdCharacters = Array.from(canonicalUserId);
    if (
      canonicalUserId.trim() !== canonicalUserId
      || userIdCharacters.length < 1
      || userIdCharacters.length > 256
      || userIdCharacters.some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      return null;
    }

    const row = this.db.prepare(
      `SELECT CASE WHEN preference.canonical_user_id IS NULL THEN 0 ELSE 1 END
                AS preference_exists,
              preference.state,
              preference.updated_at
         FROM canonical_users user
         LEFT JOIN privacy_preferences preference
           ON preference.canonical_user_id = user.id
          AND preference.preference_type = ?
        WHERE user.id = ?
        LIMIT 1`,
    ).get(preferenceType, canonicalUserId) as PrivacyPreferenceChangePreviewRow | undefined;
    if (!row) {
      return null;
    }

    let current: PrivacyPreferenceChangePreviewProjection['current'];
    if (row.preference_exists === 0 && row.state === null && row.updated_at === null) {
      current = {
        state: 'opted_in',
        version: {
          source: 'implicit_default',
          updatedAt: null,
        },
      };
    } else if (row.preference_exists === 1) {
      const state = PRIVACY_PREFERENCE_STATES.find((candidate) => candidate === row.state);
      const updatedAt = row.updated_at;
      if (
        !state
        || typeof updatedAt !== 'number'
        || !Number.isSafeInteger(updatedAt)
        || updatedAt < 0
        || updatedAt > MAX_JAVASCRIPT_DATE_MS
      ) {
        return null;
      }
      current = {
        state,
        version: {
          source: 'stored_preference',
          updatedAt,
        },
      };
    } else {
      return null;
    }
    if (current.state === targetState) {
      return null;
    }

    const payload: Omit<PrivacyPreferenceChangePreviewProjection, 'previewDigest'> = {
      action: PRIVACY_PREFERENCE_CHANGE_ACTION,
      preferenceType,
      current,
      expected: {
        state: targetState,
        durableEffects: [
          'privacy_preference_upsert',
          'audit_event_append',
        ],
        enforcementConsequences: ['preference_enforced_immediately'],
      },
      rollback: {
        supported: true,
        targetState: current.state,
        boundary: 'separate_preference_change_confirmation_required',
      },
    };
    return {
      ...payload,
      previewDigest: createHash('sha256')
        .update(PRIVACY_PREFERENCE_CHANGE_PREVIEW_DIGEST_DOMAIN, 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'),
    };
  }

  async explainStoredContext(
    turnId: string,
  ): Promise<StoredContextExplanation | null> {
    const stored = await new ContextTraceRepository(this.db).findByTurnId(turnId);
    return stored ? projectGovernanceStoredContextExplanation(stored) : null;
  }

  async resolveExplainTurn(turnId?: string): Promise<ExplainTurnResolution | null> {
    const baseQuery = `
      SELECT
        at.id,
        at.context_pack_id,
        at.conversation_id,
        cm.conversation_type,
        cm.group_id,
        cm.sender_id
      FROM agent_turns at
      LEFT JOIN chat_messages cm ON cm.raw_event_id = at.trigger_event_id
    `;

    const row = turnId
      ? this.db.prepare(`${baseQuery} WHERE at.id = ? LIMIT 1`).get(turnId)
      : this.db.prepare(`${baseQuery} ORDER BY at.started_at DESC LIMIT 1`).get();

    return row
      ? projectGovernanceExplainTurnResolution(row as ExplainTurnResolutionRow)
      : null;
  }

  async explainToolCalls(turnId: string): Promise<ToolCallExplanation[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM tool_calls
         WHERE turn_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(turnId) as ToolCallRow[];

    return rows.map(projectGovernanceToolCallExplanation);
  }

  async explainActionExecutions(actionDecisionId: string): Promise<ActionExecutionExplanation[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM action_executions
         WHERE action_decision_id = ?
         ORDER BY executed_at ASC, id ASC`,
      )
      .all(actionDecisionId) as ActionExecutionRow[];

    return rows.map(projectGovernanceActionExecutionExplanation);
  }

  async explainActionDecision(turnId: string): Promise<ActionDecisionExplanation | undefined> {
    const row = this.db
      .prepare(
        `SELECT ad.*
         FROM action_decisions ad
         LEFT JOIN agent_turns at ON at.id = ad.turn_id
         WHERE ad.turn_id = ?
         ORDER BY
           CASE WHEN at.action_decision_id = ad.id THEN 0 ELSE 1 END,
           ad.created_at DESC,
           ad.id DESC
         LIMIT 1`,
      )
      .get(turnId) as ActionDecisionRow | undefined;

    if (!row) {
      return undefined;
    }

    return projectGovernanceActionDecisionExplanation(
      row,
      await this.explainActionExecutions(row.id),
    );
  }

  async summarizeGovernanceHealth(): Promise<GovernanceHealthSummaryInspectionRecord> {
    const memoryReviews = await this.summarizeMemoryReviews();
    const actionExecutionStatusCounts = this.countByColumn('action_executions', 'status');
    const toolStatusCounts = this.countByColumn('tool_calls', 'status');
    const jobStatusCounts = this.countByColumn('jobs', 'status');
    const heartbeatStatusCounts = this.countByColumn('worker_heartbeats', 'status');
    const auditRiskCounts = this.countByColumn('audit_log', 'risk_level');
    const latestHeartbeatAt = this.latestTimestamp('worker_heartbeats', 'heartbeat_at');
    const latestEventFailureAt = this.latestTimestamp('event_processing_failures', 'occurred_at');
    const eventFailureTotal = this.countRows('event_processing_failures');
    const expiredRunningLeases = this.countRows(
      'jobs',
      'status = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?',
      ['running', Date.now()],
    );

    return {
      generatedAt: new Date(),
      memoryReviews,
      eventProcessing: {
        failuresTotal: eventFailureTotal,
        byStage: this.countByColumn('event_processing_failures', 'stage'),
        byConversationType: this.countByColumn('event_processing_failures', 'conversation_type'),
        latestFailureAt: latestEventFailureAt ? new Date(latestEventFailureAt) : undefined,
      },
      actions: {
        decisions: {
          total: this.countRows('action_decisions'),
          byDecidedBy: this.countByColumn('action_decisions', 'decided_by'),
          byRiskLevel: this.countByColumn('action_decisions', 'risk_level'),
          evaluatorRequired: this.countRows('action_decisions', 'evaluator_required = 1'),
          evaluatorPassed: this.countRows('action_decisions', 'evaluator_passed = 1'),
          evaluatorRejected: this.countRows('action_decisions', 'evaluator_passed = 0'),
        },
        executions: {
          total: this.countRows('action_executions'),
          byStatus: actionExecutionStatusCounts,
          byActionType: this.countByColumn('action_executions', 'action_type'),
          failedOrRejected: (actionExecutionStatusCounts.failed ?? 0)
            + (actionExecutionStatusCounts.rejected ?? 0),
        },
      },
      tools: {
        total: this.countRows('tool_calls'),
        byStatus: toolStatusCounts,
        secretsRedacted: this.countRows('tool_calls', 'secrets_redacted = 1'),
        failedOrRejected: (toolStatusCounts.error ?? 0)
          + (toolStatusCounts.timeout ?? 0)
          + (toolStatusCounts.rejected ?? 0),
      },
      jobs: {
        total: this.countRows('jobs'),
        byStatus: jobStatusCounts,
        byType: this.countByColumn('jobs', 'type'),
        pending: jobStatusCounts.pending ?? 0,
        running: jobStatusCounts.running ?? 0,
        failed: jobStatusCounts.failed ?? 0,
        expiredRunningLeases,
      },
      workerHeartbeats: {
        total: this.countRows('worker_heartbeats'),
        byStatus: heartbeatStatusCounts,
        byWorkerType: this.countByColumn('worker_heartbeats', 'worker_type'),
        error: heartbeatStatusCounts.error ?? 0,
        latestHeartbeatAt: latestHeartbeatAt ? new Date(latestHeartbeatAt) : undefined,
      },
      audit: {
        total: this.countRows('audit_log'),
        byCategory: this.countByColumn('audit_log', 'category'),
        byRiskLevel: auditRiskCounts,
        byEventType: this.countByColumn('audit_log', 'event_type'),
        highRisk: auditRiskCounts.high ?? 0,
        prohibitedRisk: auditRiskCounts.prohibited ?? 0,
      },
      attention: {
        unresolvedMemoryReviews: memoryReviews.unresolved,
        failedJobs: jobStatusCounts.failed ?? 0,
        expiredRunningLeases,
        errorWorkerHeartbeats: heartbeatStatusCounts.error ?? 0,
        failedOrRejectedActions: (actionExecutionStatusCounts.failed ?? 0)
          + (actionExecutionStatusCounts.rejected ?? 0),
        failedOrRejectedToolCalls: (toolStatusCounts.error ?? 0)
          + (toolStatusCounts.timeout ?? 0)
          + (toolStatusCounts.rejected ?? 0),
        eventProcessingFailures: eventFailureTotal,
        highOrProhibitedRiskAuditEvents: (auditRiskCounts.high ?? 0)
          + (auditRiskCounts.prohibited ?? 0),
      },
    };
  }

  private auditRowToInspection(row: AuditRow, includeDetails: boolean): AuditInspectionRecord {
    const summary = redactGovernanceDisplayString(row.summary);
    const details = row.details ? this.parseJson(row.details) : undefined;
    const redactedDetails = includeDetails && details !== undefined
      ? redactGovernanceStructuredValue(details)
      : { value: undefined, redacted: false };

    return {
      id: redactGovernanceDisplayString(row.id).text,
      timestamp: new Date(row.timestamp),
      category: redactGovernanceDisplayString(row.category).text,
      level: redactGovernanceDisplayString(row.level).text,
      eventType: redactGovernanceDisplayString(row.event_type).text,
      eventId: redactGovernanceDisplayString(row.event_id).text,
      actor: {
        canonicalUserId: row.actor_user_id
          ? redactGovernanceDisplayString(row.actor_user_id).text
          : undefined,
        actorClass: row.actor_class
          ? redactGovernanceDisplayString(row.actor_class).text
          : undefined,
        context: row.invocation_context
          ? redactGovernanceDisplayString(row.invocation_context).text
          : undefined,
      },
      summary: summary.text,
      details: includeDetails ? redactedDetails.value : undefined,
      detailsRedacted: !includeDetails || redactedDetails.redacted || Boolean(row.redacted),
      redacted: Boolean(row.redacted) || summary.redacted || redactedDetails.redacted || !includeDetails,
      riskLevel: row.risk_level
        ? redactGovernanceDisplayString(row.risk_level).text
        : undefined,
      evaluatorDecisionId: row.evaluator_decision_id
        ? redactGovernanceDisplayString(row.evaluator_decision_id).text
        : undefined,
    };
  }

  private memoryReviewRowToInspection(
    row: AuditRow,
    includeDetails: boolean,
  ): MemoryReviewCandidateInspectionRecord {
    const summary = redactGovernanceDisplayString(row.summary);
    const parsedDetails = row.details ? this.parseJson(row.details) : undefined;
    const redactedDetails = includeDetails && parsedDetails !== undefined
      ? redactGovernanceStructuredValue(parsedDetails)
      : { value: undefined, redacted: false };
    const memoryIdGroups = collectGovernanceMemoryIdGroups(parsedDetails)
      .map((group) => this.redactStringArray(group));
    const resolution = this.resolveMemoryReviewStatus(row.id);

    return {
      auditId: redactGovernanceDisplayString(row.id).text,
      timestamp: new Date(row.timestamp),
      eventType: row.event_type as MemoryReviewAuditEventType,
      eventId: redactGovernanceDisplayString(row.event_id).text,
      summary: summary.text,
      riskLevel: row.risk_level
        ? redactGovernanceDisplayString(row.risk_level).text
        : undefined,
      redacted: Boolean(row.redacted)
        || summary.redacted
        || redactedDetails.redacted
        || !includeDetails,
      status: resolution.status,
      candidateCount: memoryIdGroups.length,
      memoryIdGroups,
      resolutionAuditIds: resolution.resolutionAuditIds,
      supersededMemoryIds: resolution.supersededMemoryIds,
      replacementMemoryIds: resolution.replacementMemoryIds,
      disabledMemoryIds: resolution.disabledMemoryIds,
      details: includeDetails ? redactedDetails.value : undefined,
    };
  }

  private memoryMaintenanceReviewScopeToCatalogEntry(
    row: GovernanceExactScopeRow,
  ): MemoryMaintenanceReviewScopeCatalogEntry {
    const scope = this.memoryMaintenanceReviewScopeFromRow(row);
    const conversationType = scope.kind === 'conversation'
      ? scope.conversationType
      : undefined;
    const label = scope.kind === 'global'
      ? 'Global memory'
      : scope.kind === 'user'
        ? 'User memory'
        : scope.kind === 'group'
          ? 'Group memory'
          : scope.kind === 'system'
            ? 'System memory'
            : scope.conversationType === 'private'
              ? 'Private conversation memory'
              : 'Group conversation memory';
    return {
      fingerprint: this.governanceReference(
        'memory-maintenance-scope',
        JSON.stringify(scope),
      ),
      scopeKind: scope.kind,
      ...(conversationType === undefined ? {} : { conversationType }),
      label,
    };
  }

  private memoryMaintenanceReviewScopeFromRow(
    row: GovernanceExactScopeRow,
  ): MemoryMaintenanceProposalExactScope {
    switch (row.scope) {
      case 'global':
      case 'system':
        return { kind: row.scope };
      case 'user':
        if (row.canonical_user_id === null) {
          throw new Error('memory maintenance review user scope is invalid');
        }
        return { kind: 'user', canonicalUserId: row.canonical_user_id };
      case 'group':
        if (row.group_id === null) {
          throw new Error('memory maintenance review group scope is invalid');
        }
        return { kind: 'group', groupId: row.group_id };
      case 'conversation':
        if (row.conversation_id === null) {
          throw new Error('memory maintenance review conversation scope is invalid');
        }
        return row.group_id === null
          ? {
            kind: 'conversation',
            conversationId: row.conversation_id,
            conversationType: 'private',
          }
          : {
            kind: 'conversation',
            conversationId: row.conversation_id,
            conversationType: 'group',
            groupId: row.group_id,
          };
    }
  }

  private memoryMaintenanceReviewToInspection(
    proposal: MemoryMaintenanceProposalRecord,
    scopeKind: MemoryMaintenanceProposalExactScope['kind'],
  ): MemoryMaintenanceReviewInspectionRecord {
    return {
      proposalRef: this.governanceReference('memory-maintenance-proposal', proposal.proposalId),
      kind: proposal.kind,
      effectType: proposal.effectType,
      lifecycleState: proposal.lifecycleState,
      scopeKind,
      candidateFingerprint: proposal.candidateFingerprint,
      confidence: proposal.confidence,
      candidateCount: proposal.candidates.length,
      reasonCodes: [...proposal.reasonCodes],
      revisionCount: proposal.revisions.length,
      currentRevisionNumber: proposal.currentRevisionNumber,
      createdAt: new Date(proposal.createdAt),
      updatedAt: new Date(proposal.updatedAt),
      ...(proposal.expiresAt === null ? {} : { expiresAt: new Date(proposal.expiresAt) }),
    };
  }

  private toMemoryMaintenanceExactScope(
    scope: GovernanceQueryScope,
  ): MemoryMaintenanceProposalExactScope | null {
    switch (scope.kind) {
      case 'global':
      case 'system':
        return { kind: scope.kind };
      case 'user':
        return { kind: 'user', canonicalUserId: scope.canonicalUserId };
      case 'group':
        return { kind: 'group', groupId: scope.groupId };
      case 'conversation':
        return scope.conversationType === 'private'
          ? {
            kind: 'conversation',
            conversationId: scope.conversationId,
            conversationType: 'private',
          }
          : {
            kind: 'conversation',
            conversationId: scope.conversationId,
            conversationType: 'group',
            ...(scope.groupId === undefined ? {} : { groupId: scope.groupId }),
          };
      case 'tool':
        return null;
    }
  }

  private selectMemoryRecordScopeRows(scope: GovernanceQueryScope): {
    scope: MemoryMaintenanceProposalExactScope;
    rows: MemoryRecordScopeInspectionRow[];
    truncated: boolean;
  } | null {
    const predicate = this.memoryRecordExactScopePredicate(scope);
    if (!predicate) {
      return null;
    }
    const exactScope = this.toMemoryMaintenanceExactScope(scope);
    if (!exactScope) {
      return null;
    }
    const rows = this.db.prepare(
      `SELECT mr.id,
              mr.scope,
              mr.visibility,
              mr.sensitivity,
              mr.authority,
              mr.kind,
              mr.title,
              mr.content,
              mr.state,
              mr.confidence,
              mr.importance,
              mr.created_at,
              mr.updated_at,
              mr.expires_at,
              (
                SELECT COUNT(*)
                  FROM memory_sources ms
                 WHERE ms.memory_id = mr.id
              ) AS source_count,
              (
                SELECT COUNT(*)
                  FROM memory_revisions rv
                 WHERE rv.memory_id = mr.id
              ) AS revision_count
         FROM memory_records mr
        WHERE ${predicate.sql}
        ORDER BY mr.importance DESC,
                 mr.updated_at DESC,
                 mr.created_at DESC,
                 mr.id ASC
        LIMIT ?`,
    ).all(
      ...predicate.params,
      MAX_MEMORY_RECORD_PAGE_ENTRIES + 1,
    ) as MemoryRecordScopeInspectionRow[];
    return {
      scope: exactScope,
      rows: rows.slice(0, MAX_MEMORY_RECORD_PAGE_ENTRIES),
      truncated: rows.length > MAX_MEMORY_RECORD_PAGE_ENTRIES,
    };
  }

  private memoryRecordExactScopePredicate(scope: GovernanceQueryScope): {
    sql: string;
    params: unknown[];
  } | null {
    switch (scope.kind) {
      case 'global':
      case 'system':
        return {
          sql: `mr.scope = ?
            AND mr.canonical_user_id IS NULL
            AND mr.group_id IS NULL
            AND mr.conversation_id IS NULL`,
          params: [scope.kind],
        };
      case 'user':
        this.requireMemoryRecordScopeValue(scope.canonicalUserId, 'canonical user ID');
        return {
          sql: `mr.scope = 'user' AND mr.canonical_user_id = ?`,
          params: [scope.canonicalUserId],
        };
      case 'group':
        this.requireMemoryRecordScopeValue(scope.groupId, 'group ID');
        return {
          sql: `mr.scope = 'group' AND mr.group_id = ?`,
          params: [scope.groupId],
        };
      case 'conversation':
        this.requireMemoryRecordScopeValue(scope.conversationId, 'conversation ID');
        if (scope.conversationType === 'private') {
          return {
            sql: `mr.scope = 'conversation'
              AND mr.conversation_id = ?
              AND mr.group_id IS NULL`,
            params: [scope.conversationId],
          };
        }
        if (scope.groupId === undefined) {
          throw new Error('memory record group ID is invalid');
        }
        this.requireMemoryRecordScopeValue(scope.groupId, 'group ID');
        return {
          sql: `mr.scope = 'conversation'
            AND mr.conversation_id = ?
            AND mr.group_id = ?`,
          params: [scope.conversationId, scope.groupId],
        };
      case 'tool':
        return null;
    }
  }

  private requireMemoryRecordScopeValue(value: string, label: string): void {
    if (value.length === 0 || value.trim() !== value) {
      throw new Error(`memory record ${label} is invalid`);
    }
  }

  private memoryRecordScopeRowToInspection(
    row: MemoryRecordScopeInspectionRow,
  ): MemoryRecordScopeInspectionRecord {
    const textHidden = row.sensitivity === 'secret' || row.sensitivity === 'prohibited';
    const title = textHidden
      ? {
        text: RESTRICTED_MEMORY_TEXT,
        redacted: true,
        truncated: false,
      }
      : projectBoundedGovernanceText(row.title, MAX_MEMORY_RECORD_TITLE_CODE_POINTS);
    const content = textHidden
      ? {
        text: RESTRICTED_MEMORY_TEXT,
        redacted: true,
        truncated: false,
      }
      : projectBoundedGovernanceText(row.content, MAX_MEMORY_RECORD_CONTENT_CODE_POINTS);
    return {
      recordRef: this.governanceReference('memory', row.id),
      scopeKind: row.scope,
      visibility: row.visibility,
      sensitivity: row.sensitivity,
      authority: row.authority,
      kind: row.kind,
      title: title.text,
      contentPreview: content.text,
      state: row.state,
      confidence: row.confidence,
      importance: row.importance,
      sourceCount: row.source_count,
      revisionCount: row.revision_count,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      ...(row.expires_at === null ? {} : { expiresAt: new Date(row.expires_at) }),
      textHidden,
      titleRedacted: title.redacted,
      titleTruncated: title.truncated,
      contentRedacted: content.redacted,
      contentTruncated: content.truncated,
    };
  }

  private memoryRecordDetailSourceToInspection(
    memoryId: string,
    row: MemoryRecordDetailSourceRow,
  ): MemoryRecordSourceDetailInspectionRecord {
    const sourceType = MEMORY_SOURCE_TYPES.find((value) => value === row.source_type);
    const resolutionState = row.resolution_state === 'internal'
      || row.resolution_state === 'external'
      || row.resolution_state === 'legacy_unresolved'
      ? row.resolution_state
      : 'other';
    return {
      sourceRef: this.governanceReference(
        'memory-source',
        `${memoryId}\0${row.source_id}`,
      ),
      sourceType: sourceType ?? 'other',
      resolutionState,
      extractorClass: this.memoryRecordProvenanceActorClass(row.extracted_by),
      sourceTimestamp: new Date(row.source_timestamp),
    };
  }

  private memoryRecordDetailRevisionToInspection(
    row: MemoryRecordDetailRevisionRow,
    textHidden: boolean,
  ): MemoryRecordRevisionDetailInspectionRecord {
    const changeType = MEMORY_REVISION_CHANGE_TYPES.find(
      (value) => value === row.change_type,
    );
    const previousLifecycleState = this.memoryRecordLifecycleState(row.previous_state);
    const newLifecycleState = this.memoryRecordLifecycleState(row.new_state);
    const reason = row.reason === null
      ? undefined
      : textHidden
        ? { text: RESTRICTED_MEMORY_TEXT, redacted: true, truncated: false }
        : projectBoundedGovernanceText(row.reason, MAX_MEMORY_RECORD_REASON_CODE_POINTS);
    return {
      revisionRef: this.governanceReference('memory-revision', row.id),
      revisionNumber: row.revision_number,
      changeType: changeType ?? 'other',
      actorClass: this.memoryRecordProvenanceActorClass(row.actor),
      ...(previousLifecycleState === undefined ? {} : { previousLifecycleState }),
      ...(newLifecycleState === undefined ? {} : { newLifecycleState }),
      ...(reason === undefined
        ? {}
        : {
          reason: reason.text,
          reasonRedacted: reason.redacted,
          reasonTruncated: reason.truncated,
        }),
      evaluatorLinked: row.evaluator_decision_id !== null,
      createdAt: new Date(row.created_at),
    };
  }

  private memoryRecordDetailAuditToInspection(
    row: MemoryRecordDetailAuditRow,
    textHidden: boolean,
  ): MemoryRecordAuditDetailInspectionRecord {
    const level = row.level === 'summary'
      || row.level === 'redacted_full'
      || row.level === 'full'
      ? row.level
      : 'other';
    const riskLevel = row.risk_level === null
      ? undefined
      : row.risk_level === 'low'
        || row.risk_level === 'medium'
        || row.risk_level === 'high'
        || row.risk_level === 'prohibited'
        ? row.risk_level
        : 'other';
    const summary = textHidden
      ? { text: RESTRICTED_MEMORY_TEXT, redacted: true, truncated: false }
      : projectBoundedGovernanceText(
        row.summary,
        MAX_MEMORY_RECORD_AUDIT_SUMMARY_CODE_POINTS,
      );
    return {
      auditRef: this.governanceReference('memory-audit', row.id),
      timestamp: new Date(row.timestamp),
      level,
      eventType: projectBoundedGovernanceText(
        row.event_type,
        MAX_MEMORY_RECORD_CLASSIFICATION_CODE_POINTS,
      ).text,
      summary: summary.text,
      ...(riskLevel === undefined ? {} : { riskLevel }),
      summaryRedacted: summary.redacted,
      summaryTruncated: summary.truncated,
      evaluatorLinked: row.evaluator_decision_id !== null,
      detailsHidden: true,
    };
  }

  private memoryRecordProvenanceActorClass(
    value: string | null,
  ): MemoryRecordProvenanceActorClass {
    if (value === null) {
      return 'unknown';
    }
    return MEMORY_PROVENANCE_ACTOR_CLASSES.find((candidate) => candidate === value)
      ?? 'other';
  }

  private memoryRecordLifecycleState(snapshot: string | null): MemoryRecord['state'] | undefined {
    if (snapshot === null) {
      return undefined;
    }
    const state = this.stringProperty(this.parseJson(snapshot), 'state');
    return MEMORY_RECORD_STATES.find((candidate) => candidate === state);
  }

  private governanceReference(purpose: string, value: string): string {
    return createHash('sha256')
      .update(`lethebot-governance:${purpose}:v1\0`, 'utf8')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
  }

  private explainConversationScope(
    scope: GovernanceQueryScope,
  ): ExplainConversationScope | null {
    if (
      scope.kind !== 'conversation'
      || !this.isExplainScopeIdentifier(scope.conversationId)
    ) {
      return null;
    }
    if (scope.conversationType === 'private') {
      return scope.groupId === undefined
        ? {
          kind: 'conversation',
          conversationId: scope.conversationId,
          conversationType: 'private',
        }
        : null;
    }
    if (scope.conversationType !== 'group') {
      return null;
    }
    return this.isExplainScopeIdentifier(scope.groupId)
      ? {
        kind: 'conversation',
        conversationId: scope.conversationId,
        conversationType: 'group',
        groupId: scope.groupId,
      }
      : null;
  }

  private isExplainScopeIdentifier(value: unknown): value is string {
    if (
      typeof value !== 'string'
      || value.trim() !== value
    ) {
      return false;
    }
    const characters = Array.from(value);
    if (characters.length < 1 || characters.length > 256) {
      return false;
    }
    for (const character of characters) {
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
        return false;
      }
    }
    return true;
  }

  private isDisplayProfileIdentifier(value: unknown): value is string {
    if (typeof value !== 'string' || value.trim() !== value) {
      return false;
    }
    const characters = Array.from(value);
    return characters.length >= 1
      && characters.length <= 256
      && characters.every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint === undefined || (codePoint > 31 && codePoint !== 127);
      });
  }

  private memoryMaintenanceApplicationRoleFingerprint(
    role: 'retained' | 'superseded' | 'disabled',
    memoryRefs: string[],
  ): string {
    return createHash('sha256')
      .update(MEMORY_MAINTENANCE_APPLICATION_ROLE_FINGERPRINT_DOMAIN, 'utf8')
      .update(JSON.stringify({ role, memoryRefs }), 'utf8')
      .digest('hex');
  }

  private memoryMaintenanceRollbackRoleFingerprint(memoryRefs: string[]): string {
    return createHash('sha256')
      .update(MEMORY_MAINTENANCE_ROLLBACK_ROLE_FINGERPRINT_DOMAIN, 'utf8')
      .update(JSON.stringify({ role: 'restored', memoryRefs }), 'utf8')
      .digest('hex');
  }

  private createEmptyMemoryReviewSummary(
    options: MemoryReviewSummaryOptions,
  ): MemoryReviewSummaryInspectionRecord {
    const eventTypes: MemoryReviewAuditEventType[] = options.eventType
      ? [options.eventType]
      : [
          'memory.conflict.detected',
          'memory.consolidation.candidates_detected',
          'memory.decay.candidates_detected',
        ];

    return {
      generatedAt: new Date(),
      filters: {
        eventType: options.eventType,
        memoryId: options.memoryId
          ? redactGovernanceDisplayString(options.memoryId).text
          : undefined,
        status: options.status ?? 'all',
      },
      total: 0,
      resolved: 0,
      unresolved: 0,
      candidateGroups: 0,
      memoryReferences: 0,
      resolutionAuditCount: 0,
      supersededMemoryCount: 0,
      replacementMemoryCount: 0,
      disabledMemoryCount: 0,
      byEventType: eventTypes.map((eventType) => ({
        eventType,
        total: 0,
        resolved: 0,
        unresolved: 0,
        candidateGroups: 0,
        memoryReferences: 0,
        resolutionAuditCount: 0,
        supersededMemoryCount: 0,
        replacementMemoryCount: 0,
        disabledMemoryCount: 0,
      })),
    };
  }

  private addMemoryReviewCandidateToSummary(
    summary: MemoryReviewSummaryInspectionRecord,
    candidate: MemoryReviewCandidateInspectionRecord,
  ): void {
    const byEventType = summary.byEventType.find(
      (entry) => entry.eventType === candidate.eventType,
    );
    if (!byEventType) {
      return;
    }

    const memoryReferences = candidate.memoryIdGroups.flat().length;
    const isResolved = candidate.status === 'resolved';
    const targetRecords: Array<
      MemoryReviewSummaryInspectionRecord | MemoryReviewSummaryEventTypeRecord
    > = [summary, byEventType];

    for (const record of targetRecords) {
      record.total += 1;
      if (isResolved) {
        record.resolved += 1;
      } else {
        record.unresolved += 1;
      }
      record.candidateGroups += candidate.memoryIdGroups.length;
      record.memoryReferences += memoryReferences;
      record.resolutionAuditCount += candidate.resolutionAuditIds.length;
      record.supersededMemoryCount += candidate.supersededMemoryIds.length;
      record.replacementMemoryCount += candidate.replacementMemoryIds.length;
      record.disabledMemoryCount += candidate.disabledMemoryIds.length;
    }
  }

  private resolveMemoryReviewStatus(reviewAuditId: string): {
    status: Exclude<MemoryReviewResolutionStatus, 'all'>;
    resolutionAuditIds: string[];
    supersededMemoryIds: string[];
    replacementMemoryIds: string[];
    disabledMemoryIds: string[];
  } {
    const rows = this.db
      .prepare(
        `SELECT id, event_type, event_id, details
         FROM audit_log
         WHERE category = 'memory'
           AND event_type IN ('memory.supersede', 'memory.disable')
         ORDER BY timestamp ASC, id ASC`,
      )
      .all() as Array<
        Pick<AuditRow, 'id' | 'event_type' | 'event_id' | 'details'>
      >;

    const matchingRows = rows.filter((row) => {
      const details = row.details ? this.parseJson(row.details) : undefined;
      return (
        this.stringProperty(details, 'reviewAuditId') === reviewAuditId
        || this.stringProperty(details, 'decayReviewAuditId') === reviewAuditId
      );
    });

    const replacementMemoryIds = matchingRows
      .map((row) => this.stringProperty(
        row.details ? this.parseJson(row.details) : undefined,
        'replacementMemoryId',
      ))
      .filter((value): value is string => value !== undefined);
    const disabledMemoryIds = matchingRows
      .filter((row) => row.event_type === 'memory.disable')
      .map((row) => row.event_id);

    return {
      status: matchingRows.length > 0 ? 'resolved' : 'unresolved',
      resolutionAuditIds: this.redactStringArray(matchingRows.map((row) => row.id)),
      supersededMemoryIds: this.redactStringArray(
        matchingRows
          .filter((row) => row.event_type === 'memory.supersede')
          .map((row) => row.event_id),
      ),
      replacementMemoryIds: this.redactStringArray(replacementMemoryIds),
      disabledMemoryIds: this.redactStringArray(disabledMemoryIds),
    };
  }

  private countRows(
    tableName: string,
    whereClause = '1=1',
    params: unknown[] = [],
  ): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereClause}`)
      .get(...params) as { count: number };
    return row.count;
  }

  private countByColumn(
    tableName: string,
    columnName: string,
  ): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT ${columnName} AS key, COUNT(*) AS count
         FROM ${tableName}
         GROUP BY ${columnName}`,
      )
      .all() as Array<{ key: string | null; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = redactGovernanceDisplayString(row.key ?? 'none').text;
      counts[key] = (counts[key] ?? 0) + row.count;
    }
    return counts;
  }

  private countBoundedModelInvocationColumn(
    columnName: 'purpose' | 'status',
    whereClause: string,
    params: unknown[],
    allowedValues: readonly string[],
  ): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT ${columnName} AS key, COUNT(*) AS count
         FROM model_invocations
        WHERE ${whereClause}
        GROUP BY ${columnName}`,
    ).all(...params) as Array<{ key: unknown; count: number }>;
    const allowed = new Set(allowedValues);
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = typeof row.key === 'string' && allowed.has(row.key) ? row.key : 'other';
      counts[key] = (counts[key] ?? 0) + row.count;
    }
    return counts;
  }

  private latestTimestamp(tableName: string, columnName: string): number | undefined {
    const row = this.db
      .prepare(`SELECT MAX(${columnName}) AS value FROM ${tableName}`)
      .get() as { value: number | null };
    return row.value ?? undefined;
  }

  private parseJson(text: string): unknown {
    return parseGovernanceJson(text);
  }

  private stringProperty(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'string' ? property : undefined;
  }

  private redactStringArray(values: string[]): string[] {
    return redactGovernanceStringArray(values);
  }
}
