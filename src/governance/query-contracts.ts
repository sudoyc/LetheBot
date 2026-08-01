import type { LatencyAggregate } from '../operations/sqlite-maintenance.js';
import type {
  JobAttemptStatus,
  JobStatus,
  WorkerHeartbeatStatus,
} from '../storage/job-repository.js';
import type {
  MemoryMaintenanceProposalExactScope,
  MemoryMaintenanceProposalLifecycleState,
  MemoryMaintenanceProposalRecord,
} from '../storage/memory-maintenance-proposal-repository.js';
import type { StoredContextTrace } from '../storage/context-trace-repository.js';
import type {
  PrivacyPreferenceRecord,
  PrivacyPreferenceState,
  PrivacyPreferenceType,
} from '../storage/privacy-preference-repository.js';
import type {
  ActionDecision,
  ActionExecutionResult,
  ActionPlan,
  ActionType,
} from '../types/action.js';
import type { AuditEntry } from '../types/audit.js';
import type { MemoryRecord, MemoryRevision, MemorySource } from '../types/memory.js';
import type { ToolCallResult } from '../types/tool.js';

export const MEMORY_PROVENANCE_ACTOR_CLASSES = [
  'user',
  'evaluator',
  'tool',
  'worker',
  'admin',
  'human',
  'system',
  'local_admin',
] as const;

export const MEMORY_MAINTENANCE_APPROVAL_ACTION =
  'memory.maintenance.review.approve' as const;
export const MEMORY_MAINTENANCE_REJECTION_ACTION =
  'memory.maintenance.review.reject' as const;
export const MEMORY_MAINTENANCE_EXPIRATION_ACTION =
  'memory.maintenance.review.expire' as const;
export const MEMORY_MAINTENANCE_APPLICATION_ACTION =
  'memory.maintenance.apply' as const;
export const MEMORY_MAINTENANCE_ROLLBACK_ACTION =
  'memory.maintenance.rollback' as const;
export const MEMORY_RECORD_FORGET_ACTION = 'memory.record.forget' as const;
export const MEMORY_RECORD_RESTORE_ACTION = 'memory.record.restore' as const;
export const PRIVACY_PREFERENCE_CHANGE_ACTION = 'privacy.preference.change' as const;
export const GROUP_SUMMARY_POLICY_CHANGE_ACTION =
  'group.summary_policy.change' as const;
export const DISPLAY_PROFILE_REDACTION_ACTION = 'display_profile.redact' as const;
export const PLATFORM_ACCOUNT_UNLINK_ACTION = 'identity.platform_account.unlink' as const;

export type RestorableMemoryRecordState = Extract<
  MemoryRecord['state'],
  'disabled' | 'rejected' | 'deleted'
>;

export type GovernanceQueryScope =
  | { kind: 'global' }
  | { kind: 'user'; canonicalUserId: string }
  | { kind: 'group'; groupId: string }
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  }
  | { kind: 'tool'; toolName: string }
  | { kind: 'system' };

export interface MemoryMaintenanceReviewScopeCatalogEntry {
  fingerprint: string;
  scopeKind: MemoryMaintenanceProposalExactScope['kind'];
  conversationType?: 'private' | 'group';
  label: string;
}

export interface MemoryMaintenanceReviewScopeCatalog {
  entries: MemoryMaintenanceReviewScopeCatalogEntry[];
  truncated: boolean;
}

export interface MemoryMaintenanceReviewScopeHandleCatalogEntry
  extends MemoryMaintenanceReviewScopeCatalogEntry {
  handle: string;
  expiresAt: number;
}

export interface MemoryMaintenanceReviewScopeHandleCatalog {
  entries: MemoryMaintenanceReviewScopeHandleCatalogEntry[];
  truncated: boolean;
}

export type MemoryMaintenanceReviewScopeHandleIssuer = (
  scope: MemoryMaintenanceProposalExactScope,
) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export interface MemoryRecordScopeHandleCatalogEntry
  extends MemoryMaintenanceReviewScopeCatalogEntry {
  handle: string;
  expiresAt: number;
}

export interface MemoryRecordScopeHandleCatalog {
  entries: MemoryRecordScopeHandleCatalogEntry[];
  truncated: boolean;
}

export type MemoryRecordScopeHandleIssuer = (
  scope: MemoryMaintenanceProposalExactScope,
) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export interface MemoryRecordScopeInspectionRecord {
  recordRef: string;
  scopeKind: Exclude<MemoryRecord['scope'], 'tool'>;
  visibility: MemoryRecord['visibility'];
  sensitivity: MemoryRecord['sensitivity'];
  authority: MemoryRecord['authority'];
  kind: MemoryRecord['kind'];
  title: string;
  contentPreview: string;
  state: MemoryRecord['state'];
  confidence: number;
  importance: number;
  sourceCount: number;
  revisionCount: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  textHidden: boolean;
  titleRedacted: boolean;
  titleTruncated: boolean;
  contentRedacted: boolean;
  contentTruncated: boolean;
}

export interface MemoryRecordScopeInspectionPage {
  entries: MemoryRecordScopeInspectionRecord[];
  truncated: boolean;
}

export interface MemoryRecordResourceHandleInspectionRecord
  extends MemoryRecordScopeInspectionRecord {
  handle: string;
  handleExpiresAt: number;
}

export interface MemoryRecordResourceHandlePage {
  entries: MemoryRecordResourceHandleInspectionRecord[];
  truncated: boolean;
}

export type MemoryRecordResourceHandleIssuer = (input: {
  scope: MemoryMaintenanceProposalExactScope;
  memoryId: string;
}) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export type MemoryRecordProvenanceActorClass =
  | typeof MEMORY_PROVENANCE_ACTOR_CLASSES[number]
  | 'other'
  | 'unknown';

export interface MemoryRecordSourceDetailInspectionRecord {
  sourceRef: string;
  sourceType: MemorySource['sourceType'] | 'other';
  resolutionState: 'internal' | 'external' | 'legacy_unresolved' | 'other';
  extractorClass: MemoryRecordProvenanceActorClass;
  sourceTimestamp: Date;
}

export interface MemoryRecordRevisionDetailInspectionRecord {
  revisionRef: string;
  revisionNumber: number;
  changeType: MemoryRevision['changeType'] | 'other';
  actorClass: MemoryRecordProvenanceActorClass;
  previousLifecycleState?: MemoryRecord['state'];
  newLifecycleState?: MemoryRecord['state'];
  reason?: string;
  reasonRedacted?: boolean;
  reasonTruncated?: boolean;
  evaluatorLinked: boolean;
  createdAt: Date;
}

export interface MemoryRecordAuditDetailInspectionRecord {
  auditRef: string;
  timestamp: Date;
  level: 'summary' | 'redacted_full' | 'full' | 'other';
  eventType: string;
  summary: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'prohibited' | 'other';
  summaryRedacted: boolean;
  summaryTruncated: boolean;
  evaluatorLinked: boolean;
  detailsHidden: true;
}

export interface MemoryRecordDetailInspectionRecord {
  record: MemoryRecordScopeInspectionRecord;
  sources: MemoryRecordSourceDetailInspectionRecord[];
  sourcesTruncated: boolean;
  revisions: MemoryRecordRevisionDetailInspectionRecord[];
  revisionsTruncated: boolean;
  audit: MemoryRecordAuditDetailInspectionRecord[];
  auditTruncated: boolean;
}

export interface MemoryRecordForgetPreviewProjection {
  action: typeof MEMORY_RECORD_FORGET_ACTION;
  recordRef: string;
  scopeKind: MemoryMaintenanceProposalExactScope['kind'];
  current: {
    lifecycleState: Exclude<MemoryRecord['state'], 'deleted'>;
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'deleted';
    revisionNumber: number;
    durableEffects: Array<
      | 'memory_record_state_transition'
      | 'memory_revision_append'
      | 'audit_event_append'
    >;
    retrievalConsequences: Array<'deleted_record_excluded'>;
  };
  rollback: {
    supported: true;
    boundary: 'separate_restore_confirmation_required';
  };
  previewDigest: string;
}

export interface MemoryRecordRestorePreviewProjection {
  action: typeof MEMORY_RECORD_RESTORE_ACTION;
  recordRef: string;
  scopeKind: MemoryMaintenanceProposalExactScope['kind'];
  current: {
    lifecycleState: RestorableMemoryRecordState;
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'active';
    revisionNumber: number;
    durableEffects: Array<
      | 'memory_record_state_transition'
      | 'memory_revision_append'
      | 'audit_event_append'
    >;
    retrievalConsequences: Array<'restored_records_included'>;
  };
  rollback: {
    supported: true;
    boundary: 'separate_forget_confirmation_required';
  };
  previewDigest: string;
}

export type PrivacyPreferenceScope = Extract<GovernanceQueryScope, { kind: 'user' }>;

export interface PrivacyPreferenceChangePreviewProjection {
  action: typeof PRIVACY_PREFERENCE_CHANGE_ACTION;
  preferenceType: PrivacyPreferenceType;
  current: {
    state: PrivacyPreferenceState;
    version:
      | {
        source: 'implicit_default';
        updatedAt: null;
      }
      | {
        source: 'stored_preference';
        updatedAt: number;
      };
  };
  expected: {
    state: PrivacyPreferenceState;
    durableEffects: Array<'privacy_preference_upsert' | 'audit_event_append'>;
    enforcementConsequences: Array<'preference_enforced_immediately'>;
  };
  rollback: {
    supported: true;
    targetState: PrivacyPreferenceState;
    boundary: 'separate_preference_change_confirmation_required';
  };
  previewDigest: string;
}

export interface PrivacyPreferenceScopeHandleCatalogEntry {
  fingerprint: string;
  scopeKind: 'user';
  label: string;
  handle: string;
  expiresAt: number;
}

export interface PrivacyPreferenceScopeHandleCatalog {
  entries: PrivacyPreferenceScopeHandleCatalogEntry[];
  truncated: boolean;
}

export type PrivacyPreferenceScopeHandleIssuer = (
  scope: PrivacyPreferenceScope,
) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export type DisplayProfileScope = Extract<GovernanceQueryScope, { kind: 'user' }>;

export interface DisplayProfileScopeHandleCatalogEntry {
  fingerprint: string;
  scopeKind: 'user';
  label: string;
  handle: string;
  expiresAt: number;
}

export interface DisplayProfileScopeHandleCatalog {
  entries: DisplayProfileScopeHandleCatalogEntry[];
  truncated: boolean;
}

export type DisplayProfileScopeHandleIssuer = (
  scope: DisplayProfileScope,
) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export type DisplayProfileTargetKind = 'private_or_global' | 'group';
export type DisplayProfileTrust = 'platform_provided' | 'user_set' | 'inferred';
export type DisplayProfileHistoryLifecycle = 'absent' | 'open' | 'closed' | 'mixed';

export interface DisplayProfileTargetInspectionRecord {
  fingerprint: string;
  targetKind: DisplayProfileTargetKind;
  label: 'Private/global display data' | 'Group display data';
  currentProfile: {
    present: boolean;
    trust: DisplayProfileTrust | null;
    observedAt: Date | null;
  };
  history: {
    count: number;
    truncated: boolean;
    lifecycle: DisplayProfileHistoryLifecycle;
    latestObservedAt: Date | null;
  };
}

export interface DisplayProfileTargetInspectionPage {
  entries: DisplayProfileTargetInspectionRecord[];
  truncated: boolean;
}

export interface DisplayProfileTargetResourceHandleInspectionRecord
  extends DisplayProfileTargetInspectionRecord {
  handle: string;
  handleExpiresAt: number;
}

export interface DisplayProfileTargetResourceHandlePage {
  entries: DisplayProfileTargetResourceHandleInspectionRecord[];
  truncated: boolean;
}

export type DisplayProfileTargetResourceHandleIssuer = (input: {
  scope: DisplayProfileScope;
  targetId: string;
}) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export interface DisplayProfileDisplayValueInspectionRecord {
  value: string;
  redacted: boolean;
  truncated: boolean;
}

export interface DisplayProfileNicknameHistoryDetailInspectionRecord
  extends DisplayProfileDisplayValueInspectionRecord {
  fingerprint: string;
  observedAt: Date;
  observedUntil: Date | null;
}

export interface DisplayProfileTargetDetailInspectionRecord {
  target: DisplayProfileTargetInspectionRecord;
  currentDisplay: DisplayProfileDisplayValueInspectionRecord | null;
  nicknameHistory: DisplayProfileNicknameHistoryDetailInspectionRecord[];
  nicknameHistoryTruncated: boolean;
}

export interface DisplayProfileRedactionSnapshot {
  displayProfileRows: number;
  nicknameHistoryRows: number;
  openNicknameHistoryRows: number;
  snapshotFingerprint: string;
}

export interface DisplayProfileTargetRedactionPreviewProjection {
  action: typeof DISPLAY_PROFILE_REDACTION_ACTION;
  target: DisplayProfileTargetInspectionRecord;
  current: DisplayProfileRedactionSnapshot;
  expected: {
    affectedRows: {
      displayProfiles: number;
      nicknameHistory: number;
      total: number;
    };
    durableEffects: Array<
      | 'display_profile_rows_redacted'
      | 'nickname_history_rows_redacted'
      | 'open_nickname_history_rows_closed'
      | 'audit_event_append'
    >;
    privacyConsequences: Array<
      | 'display_values_enforced_as_redacted'
      | 'open_history_intervals_closed'
    >;
  };
  rollback: {
    supported: false;
    boundary: 'redacted_display_values_are_not_recoverable';
  };
  previewDigest: string;
}

export interface DisplayProfileTargetRedactionMutationSelection {
  canonicalUserId: string;
  groupId: string | null;
  targetId: string;
}

export interface PlatformAccountUnlinkSnapshot {
  snapshotFingerprint: string;
}

export interface PlatformAccountUnlinkPreviewProjection {
  action: typeof PLATFORM_ACCOUNT_UNLINK_ACTION;
  account: {
    fingerprint: string;
    platform: 'qq';
    accountType: 'private' | 'group_member' | 'temp_session';
    verifiedLevel: 'observed' | 'self_claimed' | 'owner_verified';
    status: 'active';
    firstSeenAt: Date;
    lastSeenAt: Date;
  };
  current: PlatformAccountUnlinkSnapshot;
  expected: {
    status: 'disabled';
    durableEffects: ['platform_account_status_disabled', 'audit_event_append'];
    identityConsequences: ['future_identity_resolution_blocked'];
    privacyConsequences: ['platform_account_mapping_retained'];
  };
  rollback: {
    supported: false;
    boundary: 'platform_account_relink_not_available';
  };
  previewDigest: string;
}

export interface ListMemoryMaintenanceReviewsOptions {
  scope: GovernanceQueryScope;
  states?: MemoryMaintenanceProposalLifecycleState[];
  limit?: number;
}

export interface MemoryMaintenanceReviewInspectionRecord {
  proposalRef: string;
  kind: MemoryMaintenanceProposalRecord['kind'];
  effectType: MemoryMaintenanceProposalRecord['effectType'];
  lifecycleState: MemoryMaintenanceProposalLifecycleState;
  scopeKind: MemoryMaintenanceProposalExactScope['kind'];
  candidateFingerprint: string;
  confidence: number;
  candidateCount: number;
  reasonCodes: MemoryMaintenanceProposalRecord['reasonCodes'];
  revisionCount: number;
  currentRevisionNumber: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface MemoryMaintenanceReviewListPage {
  entries: MemoryMaintenanceReviewInspectionRecord[];
  truncated: boolean;
}

export interface MemoryMaintenanceReviewResourceHandleInspectionRecord
  extends MemoryMaintenanceReviewInspectionRecord {
  handle: string;
  handleExpiresAt: number;
}

export interface MemoryMaintenanceReviewResourceHandlePage {
  entries: MemoryMaintenanceReviewResourceHandleInspectionRecord[];
  truncated: boolean;
}

export type MemoryMaintenanceReviewResourceHandleIssuer = (input: {
  scope: MemoryMaintenanceProposalExactScope;
  proposalId: string;
}) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export interface MemoryMaintenanceReviewDetailInspectionRecord
  extends MemoryMaintenanceReviewInspectionRecord {
  effectMemoryRef?: string;
  effectMemoryRole: MemoryMaintenanceProposalRecord['effectMemoryRole'];
  candidates: Array<{
    candidateOrdinal: number;
    memoryRef: string;
    effectRole: MemoryMaintenanceProposalRecord['candidates'][number]['effectRole'];
    expectedState: MemoryMaintenanceProposalRecord['candidates'][number]['expectedState'];
    recordFingerprint: string;
    sourceCount: number;
    sourceFingerprint: string;
  }>;
  candidatesTruncated: boolean;
  revisions: Array<{
    revisionNumber: number;
    transition: MemoryMaintenanceProposalRecord['revisions'][number]['transition'];
    previousState: MemoryMaintenanceProposalRecord['revisions'][number]['previousState'];
    newState: MemoryMaintenanceProposalLifecycleState;
    actorClass: MemoryMaintenanceProposalRecord['revisions'][number]['actorClass'];
    invocationContext: MemoryMaintenanceProposalRecord['revisions'][number]['invocationContext'];
    reasonCode: string;
    createdAt: Date;
  }>;
  revisionsTruncated: boolean;
}

export interface MemoryMaintenanceApprovalPreviewProjection {
  action: typeof MEMORY_MAINTENANCE_APPROVAL_ACTION;
  scope: {
    fingerprint: string;
    scopeKind: MemoryMaintenanceProposalExactScope['kind'];
    conversationType?: 'private' | 'group';
  };
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: {
    count: number;
    fingerprint: string;
  };
  current: {
    lifecycleState: 'pending_review';
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'approved';
    revisionNumber: number;
    durableEffects: Array<
      | 'proposal_state_transition'
      | 'proposal_revision_append'
      | 'audit_event_append'
    >;
    unavailableEffects: Array<'memory_record_mutation'>;
  };
  rollback: {
    supported: false;
    boundary: 'approval_does_not_apply_memory_effects';
  };
  previewDigest: string;
}

export interface MemoryMaintenanceRejectionPreviewProjection {
  action: typeof MEMORY_MAINTENANCE_REJECTION_ACTION;
  scope: {
    fingerprint: string;
    scopeKind: MemoryMaintenanceProposalExactScope['kind'];
    conversationType?: 'private' | 'group';
  };
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: {
    count: number;
    fingerprint: string;
  };
  current: {
    lifecycleState: 'pending_review';
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'rejected';
    revisionNumber: number;
    durableEffects: Array<
      | 'proposal_state_transition'
      | 'proposal_revision_append'
      | 'audit_event_append'
    >;
    unavailableEffects: Array<'memory_record_mutation'>;
  };
  rollback: {
    supported: false;
    boundary: 'rejection_does_not_apply_memory_effects';
  };
  previewDigest: string;
}

export interface MemoryMaintenanceExpirationPreviewProjection {
  action: typeof MEMORY_MAINTENANCE_EXPIRATION_ACTION;
  scope: {
    fingerprint: string;
    scopeKind: MemoryMaintenanceProposalExactScope['kind'];
    conversationType?: 'private' | 'group';
  };
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: {
    count: number;
    fingerprint: string;
  };
  current: {
    lifecycleState: 'pending_review';
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'expired';
    revisionNumber: number;
    durableEffects: Array<
      | 'proposal_state_transition'
      | 'proposal_revision_append'
      | 'audit_event_append'
    >;
    unavailableEffects: Array<'memory_record_mutation'>;
  };
  rollback: {
    supported: false;
    boundary: 'expiration_does_not_apply_memory_effects';
  };
  previewDigest: string;
}

export interface MemoryMaintenanceApplicationPreviewProjection {
  action: typeof MEMORY_MAINTENANCE_APPLICATION_ACTION;
  scope: {
    fingerprint: string;
    scopeKind: MemoryMaintenanceProposalExactScope['kind'];
    conversationType?: 'private' | 'group';
  };
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: {
    count: number;
    fingerprint: string;
    roles: Array<{
      role: 'retained' | 'superseded' | 'disabled';
      count: number;
      fingerprint: string;
    }>;
  };
  selection: {
    required: boolean;
    retainedMemoryRef?: string;
  };
  current: {
    lifecycleState: 'approved';
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'applied';
    revisionNumber: number;
    durableEffects: Array<
      | 'proposal_state_transition'
      | 'proposal_revision_append'
      | 'audit_event_append'
      | 'memory_record_revision_append'
      | 'proposal_effect_evidence_append'
    >;
    retrievalConsequences: Array<
      | 'superseded_records_excluded'
      | 'disabled_records_excluded'
    >;
  };
  rollback: {
    supported: true;
    boundary: 'separate_confirmation_required';
  };
  previewDigest: string;
}

export interface MemoryMaintenanceRollbackPreviewProjection {
  action: typeof MEMORY_MAINTENANCE_ROLLBACK_ACTION;
  scope: {
    fingerprint: string;
    scopeKind: MemoryMaintenanceProposalExactScope['kind'];
    conversationType?: 'private' | 'group';
  };
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: {
    count: number;
    fingerprint: string;
    roles: Array<{
      role: 'restored';
      count: number;
      fingerprint: string;
    }>;
  };
  current: {
    lifecycleState: 'applied';
    revisionNumber: number;
  };
  expected: {
    lifecycleState: 'rolled_back';
    revisionNumber: number;
    durableEffects: Array<
      | 'proposal_state_transition'
      | 'proposal_revision_append'
      | 'audit_event_append'
      | 'memory_record_revision_append'
      | 'proposal_effect_evidence_append'
    >;
    retrievalConsequences: Array<'restored_records_included'>;
  };
  confirmation: {
    required: true;
    boundary: 'separate_confirmation_required';
  };
  previewDigest: string;
}

export interface ResolvedMemoryMaintenanceApplication {
  preview: MemoryMaintenanceApplicationPreviewProjection;
  retainedMemoryId?: string;
}

export interface MemoryMaintenanceApplicationConfirmationProjection {
  action: typeof MEMORY_MAINTENANCE_APPLICATION_ACTION;
  outcome: 'applied';
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: MemoryMaintenanceApplicationPreviewProjection['affectedRecords'];
  selection: MemoryMaintenanceApplicationPreviewProjection['selection'];
  current: {
    lifecycleState: 'applied';
    revisionNumber: number;
  };
  retrievalConsequences:
    MemoryMaintenanceApplicationPreviewProjection['expected']['retrievalConsequences'];
  evidence: {
    transition: 'apply';
    revisionRef: string;
    auditRef: string;
  };
  rollback: {
    supported: true;
    boundary: 'separate_confirmation_required';
  };
}

export interface MemoryMaintenanceRollbackConfirmationProjection {
  action: typeof MEMORY_MAINTENANCE_ROLLBACK_ACTION;
  outcome: 'rolled_back';
  proposalKind: MemoryMaintenanceProposalRecord['kind'];
  proposalRef: string;
  proposedEffect: MemoryMaintenanceProposalRecord['effectType'];
  affectedRecords: MemoryMaintenanceRollbackPreviewProjection['affectedRecords'];
  current: {
    lifecycleState: 'rolled_back';
    revisionNumber: number;
  };
  retrievalConsequences:
    MemoryMaintenanceRollbackPreviewProjection['expected']['retrievalConsequences'];
  evidence: {
    transition: 'rollback';
    revisionRef: string;
    auditRef: string;
  };
  rollback: {
    supported: false;
    boundary: 'rollback_is_terminal';
  };
}

export interface MemoryMaintenanceApprovalConfirmationProjection {
  action: typeof MEMORY_MAINTENANCE_APPROVAL_ACTION;
  outcome: 'approved';
  proposalRef: string;
  current: {
    lifecycleState: 'approved';
    revisionNumber: number;
  };
  evidence: {
    transition: 'approve';
    revisionRef: string;
    auditRef: string;
  };
  memoryRecordMutation: false;
  rollback: {
    supported: false;
    boundary: 'approval_does_not_apply_memory_effects';
  };
}

export interface MemoryMaintenanceRejectionConfirmationProjection {
  action: typeof MEMORY_MAINTENANCE_REJECTION_ACTION;
  outcome: 'rejected';
  proposalRef: string;
  current: {
    lifecycleState: 'rejected';
    revisionNumber: number;
  };
  evidence: {
    transition: 'reject';
    revisionRef: string;
    auditRef: string;
  };
  memoryRecordMutation: false;
  rollback: {
    supported: false;
    boundary: 'rejection_does_not_apply_memory_effects';
  };
}

export interface MemoryMaintenanceExpirationConfirmationProjection {
  action: typeof MEMORY_MAINTENANCE_EXPIRATION_ACTION;
  outcome: 'expired';
  proposalRef: string;
  current: {
    lifecycleState: 'expired';
    revisionNumber: number;
  };
  evidence: {
    transition: 'expire';
    revisionRef: string;
    auditRef: string;
  };
  memoryRecordMutation: false;
  rollback: {
    supported: false;
    boundary: 'expiration_does_not_apply_memory_effects';
  };
}

export interface ListAuditOptions {
  category?: AuditEntry['category'];
  level?: AuditEntry['level'];
  eventType?: string;
  eventId?: string;
  userId?: string;
  riskLevel?: AuditEntry['riskLevel'];
  startTime?: Date;
  endTime?: Date;
  includeDetails?: boolean;
  limit?: number;
}

export interface ListMemoryOptions {
  userId?: string;
  groupId?: string;
  conversationId?: string;
  state?: MemoryRecord['state'];
  scope?: MemoryRecord['scope'];
  sensitivity?: MemoryRecord['sensitivity'];
  sourceContext?: string;
  sourceType?: MemorySource['sourceType'];
  sourceId?: string;
  limit?: number;
}

export interface ExportMemoryRecord {
  id: string;
  scope: string;
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
  subjectUserId?: string;
  visibility: string;
  sensitivity: string;
  authority: string;
  kind: string;
  title: string;
  content: string;
  state: string;
  confidence: number;
  importance: number;
  sourceContext: string;
  sourceEventIds: string[];
  evaluatorDecisionId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export type ModelInvocationPurpose = 'summary' | 'evaluator' | 'pi_turn';
export type ModelInvocationStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface SummarizeModelInvocationsOptions {
  purpose?: ModelInvocationPurpose;
  status?: ModelInvocationStatus;
}

export interface ModelInvocationSummaryInspectionRecord {
  generatedAt: Date;
  filters: {
    purpose?: ModelInvocationPurpose;
    status?: ModelInvocationStatus;
  };
  total: number;
  byPurpose: Record<string, number>;
  byStatus: Record<string, number>;
  completedKnownUsage: number;
  completedUnknownUsage: number;
  providerLatencyMs: LatencyAggregate;
}

export interface ListToolCallOptions {
  turnId?: string;
  toolName?: string;
  status?: ToolCallResult['status'];
  includePayload?: boolean;
  limit?: number;
}

export interface ToolCallInspectionRecord {
  id: string;
  turnId: string;
  toolName: string;
  requestedBy: string;
  actor: {
    canonicalUserId?: string;
    actorClass: string;
  };
  context: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  executionTimeMs?: number;
  secretsRedacted: boolean;
  createdAt: Date;
  input?: unknown;
  output?: unknown;
}

export interface ListActionDecisionOptions {
  turnId?: string;
  decidedBy?: ActionDecision['decidedBy'];
  riskLevel?: ActionDecision['riskLevel'];
  includeActions?: boolean;
  limit?: number;
}

export interface ActionDecisionInspectionRecord {
  id: string;
  turnId: string;
  createdAt: Date;
  decidedBy: string;
  riskLevel: string;
  confidence: number;
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  actionCount: number;
  actions?: ActionPlan[];
  reasons: string[];
  suppressors: string[];
}

export interface ListActionExecutionOptions {
  actionDecisionId?: string;
  actionType?: ActionType;
  status?: ActionExecutionResult['status'];
  includeAuditEntry?: boolean;
  limit?: number;
}

export interface ActionExecutionInspectionRecord {
  id: string;
  actionDecisionId: string;
  actionType: string;
  status: string;
  executedMessageId?: string;
  executedMemoryId?: string;
  executedJobId?: string;
  downgradedFrom?: string;
  downgradedReason?: string;
  errorCode?: string;
  errorMessage?: string;
  auditLevel: string;
  auditEntry?: string;
  executedAt: Date;
}

export interface ListJobOptions {
  status?: JobStatus;
  type?: string;
  includePayload?: boolean;
  limit?: number;
}

export interface JobInspectionRecord {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  heartbeatAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  payload?: unknown;
  result?: unknown;
}

export interface ListJobAttemptOptions {
  jobId?: string;
  workerId?: string;
  status?: JobAttemptStatus;
  includeResult?: boolean;
  limit?: number;
}

export interface JobAttemptInspectionRecord {
  id: string;
  jobId: string;
  attemptNumber: number;
  workerId: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  heartbeatAt?: Date;
  error?: string;
  result?: unknown;
}

export interface ListWorkerHeartbeatOptions {
  workerId?: string;
  workerType?: string;
  status?: WorkerHeartbeatStatus;
  includeDetails?: boolean;
  limit?: number;
}

export interface WorkerHeartbeatInspectionRecord {
  workerId: string;
  workerType: string;
  status: string;
  currentJobId?: string;
  heartbeatAt: Date;
  details?: unknown;
}

export interface ListEventProcessingFailureOptions {
  stage?: string;
  rawEventId?: string;
  turnId?: string;
  includeDetails?: boolean;
  limit?: number;
}

export interface EventProcessingFailureInspectionRecord {
  id: string;
  rawEventId?: string;
  turnId?: string;
  occurredAt: Date;
  stage: string;
  conversationType?: 'private' | 'group';
  errorName: string;
  errorMessageHash: string;
  messageIdHash?: string;
  senderIdHash?: string;
  conversationIdHash?: string;
  details?: unknown;
}

export interface GroupSummaryPolicyScopeInspection {
  state: 'enabled' | 'disabled';
  stored: boolean;
  generation: number | null;
  eligibleAfter: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface GroupSummaryPolicyChangePreviewProjection {
  action: typeof GROUP_SUMMARY_POLICY_CHANGE_ACTION;
  current: {
    state: GroupSummaryPolicyScopeInspection['state'];
    stored: boolean;
    version: {
      generation: number | null;
      updatedAt: Date | null;
    };
  };
  expected: {
    state: GroupSummaryPolicyScopeInspection['state'];
    generation: number;
    durableEffects: Array<
      | 'group_summary_policy_upsert'
      | 'audit_event_append'
      | 'pending_group_summary_jobs_terminalized'
    >;
    enforcementConsequences: Array<
      | 'policy_generation_advanced'
      | 'pre_enable_sources_excluded'
      | 'group_summary_generation_and_retrieval_enabled'
      | 'group_summary_generation_and_retrieval_disabled'
      | 'pending_group_summary_jobs_canceled'
    >;
  };
  rollback: {
    supported: true;
    targetState: GroupSummaryPolicyScopeInspection['state'];
    boundary: 'separate_group_summary_policy_change_confirmation_required';
  };
  previewDigest: string;
}

export type GroupSummaryPolicyScope = Extract<GovernanceQueryScope, { kind: 'group' }>;

export interface GroupSummaryPolicyScopeHandleCatalogEntry {
  fingerprint: string;
  scopeKind: 'group';
  label: 'Group summary policy';
  handle: string;
  expiresAt: number;
}

export interface GroupSummaryPolicyScopeHandleCatalog {
  entries: GroupSummaryPolicyScopeHandleCatalogEntry[];
  truncated: boolean;
}

export type GroupSummaryPolicyScopeHandleIssuer = (
  scope: GroupSummaryPolicyScope,
) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export interface ListPrivacyPreferenceOptions {
  canonicalUserId?: string;
  preferenceType?: PrivacyPreferenceType;
  state?: PrivacyPreferenceState;
  limit?: number;
}

export interface PrivacyPreferenceInspectionRecord extends Omit<
  PrivacyPreferenceRecord,
  'preferenceType' | 'state' | 'updatedBy'
> {
  preferenceType: string;
  state: string;
  updatedBy?: {
    canonicalUserId?: string;
    actorClass: string;
    context: string;
  };
}

export interface PrivacyPreferenceScopeInspectionRecord {
  preferenceType: string;
  state: string;
  reason?: string;
  updatedBy?: {
    actorClass: string;
    context: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface PrivacyPreferenceScopeInspectionPage {
  entries: PrivacyPreferenceScopeInspectionRecord[];
  truncated: boolean;
}

export type ExplainConversationScope =
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'private';
  }
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'group';
    groupId: string;
  };

export interface ExplainConversationScopeHandleCatalogEntry {
  fingerprint: string;
  scopeKind: 'conversation';
  conversationType: 'private' | 'group';
  label: string;
  handle: string;
  expiresAt: number;
}

export interface ExplainConversationScopeHandleCatalog {
  entries: ExplainConversationScopeHandleCatalogEntry[];
  truncated: boolean;
}

export type ExplainConversationScopeHandleIssuer = (
  scope: ExplainConversationScope,
) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export type ExplainTurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

export interface ExplainTurnScopeInspectionRecord {
  fingerprint: string;
  label: 'Turn';
  traceSource: 'stored';
  status: ExplainTurnStatus;
  startedAt: Date;
  completedAt?: Date;
}

export interface ExplainTurnScopeInspectionPage {
  entries: ExplainTurnScopeInspectionRecord[];
  truncated: boolean;
}

export interface ExplainTurnResourceHandleInspectionRecord
  extends ExplainTurnScopeInspectionRecord {
  handle: string;
  handleExpiresAt: number;
}

export interface ExplainTurnResourceHandlePage {
  entries: ExplainTurnResourceHandleInspectionRecord[];
  truncated: boolean;
}

export type ExplainTurnResourceHandleIssuer = (input: {
  scope: ExplainConversationScope;
  turnId: string;
}) => {
  handle: string;
  expiresAt: number;
} | Promise<{
  handle: string;
  expiresAt: number;
}>;

export interface ExplainTurnDetailLabelInspectionRecord {
  label: string;
  redacted: boolean;
  truncated: boolean;
}

export interface ExplainTurnDetailTokenBudgetInspectionRecord {
  max: number;
  used: number;
  breakdown: {
    recentMessages: number;
    memory: number;
    identity: number;
    system: number;
  };
}

export interface ExplainTurnContextDetailInspectionRecord {
  traceSource: 'stored';
  candidateMemoryCount: number;
  selectedMemoryCount: number;
  rejectedMemoryCount: number;
  recentMessageCount: number;
  includedMemoryCount: number;
  filters: ExplainTurnDetailLabelInspectionRecord[];
  filtersTruncated: boolean;
  injectedIdentityFields: ExplainTurnDetailLabelInspectionRecord[];
  injectedIdentityFieldsTruncated: boolean;
  tokenBudget?: ExplainTurnDetailTokenBudgetInspectionRecord;
}

export type ExplainTurnDetailActionType = ActionType | 'other';

export type ExplainTurnDetailExecutionEffect =
  | 'true_reaction'
  | 'face_message_fallback'
  | 'silent_reaction_fallback';

export interface ExplainTurnExecutionDetailInspectionRecord {
  actionType: ExplainTurnDetailActionType;
  status: ActionExecutionResult['status'];
  effect?: ExplainTurnDetailExecutionEffect;
  executedMessage: boolean;
  executedMemory: boolean;
  scheduledJob: boolean;
  downgradedFrom?: ExplainTurnDetailActionType;
  errorCode?: string;
  errorCodeRedacted: boolean;
  errorCodeTruncated: boolean;
  executedAt: Date;
}

export interface ExplainTurnActionDecisionDetailInspectionRecord {
  decidedBy: ActionDecision['decidedBy'];
  riskLevel: ActionDecision['riskLevel'];
  confidence: number;
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  actionCount: number;
  actionTypes: ExplainTurnDetailActionType[];
  actionTypesTruncated: boolean;
  reasonCount: number;
  suppressorCount: number;
  executions: ExplainTurnExecutionDetailInspectionRecord[];
  executionsTruncated: boolean;
}

export interface ExplainTurnToolDetailInspectionRecord {
  toolName: string;
  toolNameRedacted: boolean;
  toolNameTruncated: boolean;
  requestedBy: 'pi' | 'evaluator' | 'user' | 'system';
  status: ToolCallResult['status'];
  errorCode?: string;
  errorCodeRedacted: boolean;
  errorCodeTruncated: boolean;
  executionTimeMs?: number;
  secretsRedacted: boolean;
  createdAt: Date;
}

export interface ExplainTurnDetailInspectionRecord {
  turn: ExplainTurnScopeInspectionRecord;
  context: ExplainTurnContextDetailInspectionRecord;
  actionDecision?: ExplainTurnActionDecisionDetailInspectionRecord;
  tools: ExplainTurnToolDetailInspectionRecord[];
  toolsTruncated: boolean;
}

export interface StoredContextExplanation extends Omit<
  StoredContextTrace,
  'createdAt' | 'referenceTrace'
> {
  traceSource: 'stored';
}

export interface ExplainTurnResolution {
  turnId: string;
  contextPackId: string | null;
  conversationId: string;
  conversationType: 'private' | 'group' | null;
  groupId: string | null;
  senderId: string | null;
}

export interface ToolCallExplanation {
  id: string;
  toolName: string;
  requestedBy: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  executionTimeMs?: number;
}

export interface ActionExecutionExplanation {
  id: string;
  actionType: string;
  status: string;
  effect?: string;
  executedMessageId?: string;
  executedMemoryId?: string;
  executedJobId?: string;
  downgradedFrom?: string;
  downgradedReason?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ActionDecisionExplanation {
  id: string;
  decidedBy: string;
  riskLevel: string;
  actionTypes: string[];
  reasons: string[];
  suppressors: string[];
  executions: ActionExecutionExplanation[];
}

export interface AuditInspectionRecord {
  id: string;
  timestamp: Date;
  category: string;
  level: string;
  eventType: string;
  eventId: string;
  actor: {
    canonicalUserId?: string;
    actorClass?: string;
    context?: string;
  };
  summary: string;
  details?: unknown;
  detailsRedacted: boolean;
  redacted: boolean;
  riskLevel?: string;
  evaluatorDecisionId?: string;
}

export interface MemorySourceInspectionRecord extends Omit<MemorySource, 'sourceType' | 'extractedBy'> {
  sourceType: string;
  extractedBy?: string;
}

export interface MemoryRecordInspectionRecord extends Omit<
  MemoryRecord,
  'scope' | 'visibility' | 'sensitivity' | 'authority' | 'kind' | 'state'
> {
  scope: string;
  visibility: string;
  sensitivity: string;
  authority: string;
  kind: string;
  state: string;
}

export interface ShowMemoryResult {
  record: MemoryRecordInspectionRecord;
  sources: MemorySourceInspectionRecord[];
  revisions: Array<{
    id: string;
    memoryId: string;
    revisionNumber: number;
    changeType: string;
    actor: string;
    reason: string;
    evaluatorDecisionId?: string;
    createdAt: Date;
    previousState?: unknown;
    newState: unknown;
  }>;
  audit: AuditInspectionRecord[];
}

export type MemoryReviewAuditEventType =
  | 'memory.conflict.detected'
  | 'memory.consolidation.candidates_detected'
  | 'memory.decay.candidates_detected';

export type MemoryReviewResolutionStatus = 'all' | 'resolved' | 'unresolved';

export interface MemoryReviewSummaryOptions {
  eventType?: MemoryReviewAuditEventType;
  memoryId?: string;
  status?: MemoryReviewResolutionStatus;
}

export interface ListMemoryReviewOptions extends MemoryReviewSummaryOptions {
  includeDetails?: boolean;
  limit?: number;
}

export interface MemoryReviewCandidateInspectionRecord {
  auditId: string;
  timestamp: Date;
  eventType: MemoryReviewAuditEventType;
  eventId: string;
  summary: string;
  riskLevel?: string;
  redacted: boolean;
  status: Exclude<MemoryReviewResolutionStatus, 'all'>;
  candidateCount: number;
  memoryIdGroups: string[][];
  resolutionAuditIds: string[];
  supersededMemoryIds: string[];
  replacementMemoryIds: string[];
  disabledMemoryIds: string[];
  details?: unknown;
}

export interface MemoryReviewSummaryEventTypeRecord {
  eventType: MemoryReviewAuditEventType;
  total: number;
  resolved: number;
  unresolved: number;
  candidateGroups: number;
  memoryReferences: number;
  resolutionAuditCount: number;
  supersededMemoryCount: number;
  replacementMemoryCount: number;
  disabledMemoryCount: number;
}

export interface MemoryReviewSummaryInspectionRecord {
  generatedAt: Date;
  filters: {
    eventType?: MemoryReviewAuditEventType;
    memoryId?: string;
    status: MemoryReviewResolutionStatus;
  };
  total: number;
  resolved: number;
  unresolved: number;
  candidateGroups: number;
  memoryReferences: number;
  resolutionAuditCount: number;
  supersededMemoryCount: number;
  replacementMemoryCount: number;
  disabledMemoryCount: number;
  byEventType: MemoryReviewSummaryEventTypeRecord[];
}

export interface GovernanceHealthSummaryInspectionRecord {
  generatedAt: Date;
  memoryReviews: MemoryReviewSummaryInspectionRecord;
  eventProcessing: {
    failuresTotal: number;
    byStage: Record<string, number>;
    byConversationType: Record<string, number>;
    latestFailureAt?: Date;
  };
  actions: {
    decisions: {
      total: number;
      byDecidedBy: Record<string, number>;
      byRiskLevel: Record<string, number>;
      evaluatorRequired: number;
      evaluatorPassed: number;
      evaluatorRejected: number;
    };
    executions: {
      total: number;
      byStatus: Record<string, number>;
      byActionType: Record<string, number>;
      failedOrRejected: number;
    };
  };
  tools: {
    total: number;
    byStatus: Record<string, number>;
    secretsRedacted: number;
    failedOrRejected: number;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    pending: number;
    running: number;
    failed: number;
    expiredRunningLeases: number;
  };
  workerHeartbeats: {
    total: number;
    byStatus: Record<string, number>;
    byWorkerType: Record<string, number>;
    error: number;
    latestHeartbeatAt?: Date;
  };
  audit: {
    total: number;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
    byEventType: Record<string, number>;
    highRisk: number;
    prohibitedRisk: number;
  };
  attention: {
    unresolvedMemoryReviews: number;
    failedJobs: number;
    expiredRunningLeases: number;
    errorWorkerHeartbeats: number;
    failedOrRejectedActions: number;
    failedOrRejectedToolCalls: number;
    eventProcessingFailures: number;
    highOrProhibitedRiskAuditEvents: number;
  };
}
