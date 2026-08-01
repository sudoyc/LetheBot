import {
  PLATFORM_ACCOUNT_UNLINK_ACTION,
  type GovernanceQueryService,
} from '../governance/query-service.js';
import type { GovernanceOperationsCoordinator } from '../governance/operations-coordinator.js';
import {
  PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
  type GovernanceService,
} from '../governance/service.js';
import { prepareGovernanceRestoreHandoff } from '../operations/governance-restore-handoff.js';
import * as governanceContract from './governance-application-contracts.js';
import type { GovernanceHttpServerOptions } from './governance-http-server.js';
import type { GovernancePreviewHandleRegistry } from './governance-preview-handle-registry.js';
import type { GovernanceResourceHandleRegistry } from './governance-resource-handle-registry.js';
import type { GovernanceScopeHandleRegistry } from './governance-scope-handle-registry.js';

export interface GovernanceUnscopedHandlerDependencies {
  readonly databasePath: string;
  readonly now: () => number;
  readonly governanceQueries: GovernanceQueryService;
  readonly governanceOperations: GovernanceOperationsCoordinator;
  readonly governanceScopeHandles: GovernanceScopeHandleRegistry;
  readonly governanceResourceHandles: GovernanceResourceHandleRegistry;
  readonly governancePreviewHandles: GovernancePreviewHandleRegistry;
  readonly governance: GovernanceService;
}

export function createGovernanceUnscopedHandler(
  dependencies: GovernanceUnscopedHandlerDependencies,
): GovernanceHttpServerOptions['handleAuthenticatedUnscopedRequest'] {
  const {
    databasePath,
    now,
    governanceQueries,
    governanceOperations,
    governanceScopeHandles,
    governanceResourceHandles,
    governancePreviewHandles,
    governance,
  } = dependencies;

  return async ({ actor, route, session, body }) => {
        if (route.purpose === governanceContract.GOVERNANCE_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryMaintenanceReviewScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_MEMORY_REVIEW_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_MEMORY_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryRecordScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_MEMORY_RECORDS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_PRIVACY_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listPrivacyPreferenceScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_GROUP_SUMMARY_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listGroupSummaryPolicyScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_DISPLAY_PROFILE_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listDisplayProfileScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (
          route.path === governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_CONFIRM_PATH
          && route.purpose === governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const resourceHandle = bodyRecord?.resourceHandle;
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('resourceHandle')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof resourceHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(resourceHandle)
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const scope = { kind: 'system' as const };
          const resource = governanceResourceHandles.resolve({
            sessionId: session.sessionId,
            handle: resourceHandle,
            purpose: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
            resourceKind: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            scope,
          });
          if (!resource || resource.kind !== governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND) {
            return { status: 404, body: { error: 'not_found' } };
          }

          let selectorValue: unknown;
          try {
            selectorValue = JSON.parse(resource.resourceId);
          } catch {
            return { status: 404, body: { error: 'not_found' } };
          }
          const selector = typeof selectorValue === 'object'
            && selectorValue !== null
            && !Array.isArray(selectorValue)
            ? selectorValue as Record<string, unknown>
            : null;
          const selectorKeys = selector ? Object.keys(selector) : [];
          const platformAccountId = selector?.platformAccountId;
          if (
            selectorKeys.length !== 2
            || !selectorKeys.includes('platform')
            || !selectorKeys.includes('platformAccountId')
            || selector?.platform !== 'qq'
            || typeof platformAccountId !== 'string'
            || !governanceContract.GOVERNANCE_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(platformAccountId)
            || resource.resourceId !== JSON.stringify({
              platform: 'qq',
              platformAccountId,
            })
          ) {
            return { status: 404, body: { error: 'not_found' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: PLATFORM_ACCOUNT_UNLINK_ACTION,
            resourceKind: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = await governanceQueries.getPlatformAccountUnlinkPreview({
            platform: 'qq',
            platformAccountId,
          });
          if (
            !currentPreview
            || consumed.binding.expectedState
              !== currentPreview.current.snapshotFingerprint
            || consumed.binding.expectedRevisionNumber !== 1
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          const result = governance.unlinkPlatformAccountAsLocalAdmin({
            platform: 'qq',
            platformAccountId,
            expectedSnapshot: currentPreview.current,
            reasonCode: PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
          });
          if (result.outcome !== 'unlinked') {
            return { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: PLATFORM_ACCOUNT_UNLINK_ACTION,
              outcome: 'unlinked',
              account: {
                ...currentPreview.account,
                status: 'disabled',
              },
              affectedRows: { platformAccounts: 1 },
              disabledAt: new Date(result.disabledAt),
              durableEffects: [...currentPreview.expected.durableEffects],
              identityConsequences: [...currentPreview.expected.identityConsequences],
              privacyConsequences: [...currentPreview.expected.privacyConsequences],
              evidence: {
                auditEvent: 'identity.platform_account.unlinked',
                reasonCode: PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.path === governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PATH
          && route.purpose === governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const platformAccountId = bodyRecord?.platformAccountId;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('platform')
            || !bodyKeys.includes('platformAccountId')
            || bodyRecord?.action !== 'unlink'
            || bodyRecord.platform !== 'qq'
            || typeof platformAccountId !== 'string'
            || !governanceContract.GOVERNANCE_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(platformAccountId)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const preview = await governanceQueries.getPlatformAccountUnlinkPreview({
            platform: 'qq',
            platformAccountId,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const scope = { kind: 'system' as const };
          const resourceId = JSON.stringify({
            platform: 'qq',
            platformAccountId,
          });
          const resource = governanceResourceHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            purpose: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
            resourceKind: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            resourceId,
            scope,
          });
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: PLATFORM_ACCOUNT_UNLINK_ACTION,
            resourceKind: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            resourceId,
            scope,
            expectedState: preview.current.snapshotFingerprint,
            expectedRevisionNumber: 1,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              resourceHandle: resource.handle,
              resourceExpiresAt: resource.expiresAt,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_EXPLAIN_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listExplainConversationScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OVERVIEW_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.summarizeGovernanceHealth(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_PURPOSE) {
          return {
            status: 200,
            body: governanceOperations.inspect(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_BACKUP_PREVIEW_PURPOSE) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action
              !== governanceContract.GOVERNANCE_OPERATIONS_BACKUP_ACTION
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = governanceOperations.previewVerifiedBackup();
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: preview.action,
            resourceKind: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_KIND,
            resourceId: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_ID,
            scope: { kind: 'system' },
            expectedState: preview.currentState,
            expectedRevisionNumber: preview.contractVersion,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_RETENTION_PREVIEW_PURPOSE) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action
              !== governanceContract.GOVERNANCE_OPERATIONS_RETENTION_ACTION
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = governanceOperations.previewConfiguredRetention();
          const expectedAtMs = Date.parse(preview.asOf);
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: preview.action,
            resourceKind: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_KIND,
            resourceId: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_ID,
            scope: { kind: 'system' },
            expectedState: preview.currentState,
            expectedRevisionNumber: preview.contractVersion,
            previewDigest: preview.previewDigest,
            expectedAtMs,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_ACTION,
            resourceKind: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_KIND,
            resourceId: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_ID,
            scope: { kind: 'system' },
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }
          if (consumed.binding.expectedAtMs === undefined) {
            return { status: 409, body: { error: 'conflict' } };
          }

          try {
            const confirmation = governanceOperations.confirmConfiguredRetention({
              expectedState: consumed.binding.expectedState,
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              previewDigest: consumed.binding.previewDigest,
              expectedAtMs: consumed.binding.expectedAtMs,
            });
            return confirmation
              ? { status: 200, body: confirmation }
              : { status: 409, body: { error: 'conflict' } };
          } catch (error) {
            return isSqliteBusyError(error)
              ? { status: 503, body: { error: 'temporarily_unavailable' } }
              : { status: 500, body: { error: 'internal_error' } };
          }
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_RESTORE_PREVIEW_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const backupRef = bodyRecord?.backupRef;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('backupRef')
            || bodyRecord?.action !== governanceContract.GOVERNANCE_OPERATIONS_RESTORE_ACTION
            || typeof backupRef !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(backupRef)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const preview = governanceOperations.previewServerOwnedBackupRestore(backupRef);
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: preview.action,
            resourceKind: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_RESOURCE_KIND,
            resourceId: backupRef,
            scope: { kind: 'system' },
            expectedState: preview.currentState,
            expectedRevisionNumber: preview.contractVersion,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const backupRef = bodyRecord?.backupRef;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || !bodyKeys.includes('backupRef')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || typeof backupRef !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(backupRef)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_ACTION,
            resourceKind: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_RESOURCE_KIND,
            resourceId: backupRef,
            scope: { kind: 'system' },
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = governanceOperations.previewServerOwnedBackupRestore(backupRef);
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.currentState
            || consumed.binding.expectedRevisionNumber !== currentPreview.contractVersion
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          return {
            status: 200,
            body: prepareGovernanceRestoreHandoff({
              databasePath,
              backupRef,
              previewDigest: currentPreview.previewDigest,
              contractVersion: currentPreview.contractVersion,
              now: new Date(now()),
            }),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_OPERATIONS_BACKUP_CONFIRM_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_ACTION,
            resourceKind: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_KIND,
            resourceId: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_ID,
            scope: { kind: 'system' },
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = governanceOperations.previewVerifiedBackup();
          if (
            consumed.binding.expectedState !== currentPreview.currentState
            || consumed.binding.expectedRevisionNumber !== currentPreview.contractVersion
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          return {
            status: 200,
            body: await governanceOperations.createServerOwnedVerifiedBackup(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.summarizeModelInvocations(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listWorkerHeartbeats(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_JOBS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listJobs(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listJobAttempts(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_TOOL_CALLS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listToolCalls(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listActionDecisions(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listActionExecutions(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listEventProcessingFailures(),
          };
        }
        if (route.purpose === governanceContract.GOVERNANCE_ACTIVITY_AUDIT_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listAudit(),
          };
        }
        return { status: 404, body: { error: 'not_found' } };
  };
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = error.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}
