import {
  MEMORY_MAINTENANCE_APPLICATION_ACTION,
  MEMORY_MAINTENANCE_APPROVAL_ACTION,
  MEMORY_MAINTENANCE_EXPIRATION_ACTION,
  MEMORY_MAINTENANCE_REJECTION_ACTION,
  MEMORY_MAINTENANCE_ROLLBACK_ACTION,
  MEMORY_RECORD_FORGET_ACTION,
  MEMORY_RECORD_RESTORE_ACTION,
  DISPLAY_PROFILE_REDACTION_ACTION,
  GROUP_SUMMARY_POLICY_CHANGE_ACTION,
  PRIVACY_PREFERENCE_CHANGE_ACTION,
  type GovernanceQueryService,
  type ResolvedMemoryMaintenanceApplication,
} from '../governance/query-service.js';
import {
  DISPLAY_PROFILE_REDACTION_REASON_CODE,
  type GovernanceService,
} from '../governance/service.js';
import type { GroupSummaryPolicyExpectedVersion } from '../storage/group-summary-policy-repository.js';
import * as governanceContract from './governance-application-contracts.js';
import type { GovernanceHttpServerOptions } from './governance-http-server.js';
import type { GovernancePreviewHandleRegistry } from './governance-preview-handle-registry.js';
import type { GovernanceResourceHandleRegistry } from './governance-resource-handle-registry.js';

export interface GovernanceAuthorizedHandlerDependencies {
  readonly governanceQueries: GovernanceQueryService;
  readonly governanceResourceHandles: GovernanceResourceHandleRegistry;
  readonly governancePreviewHandles: GovernancePreviewHandleRegistry;
  readonly governance: GovernanceService;
}

export function createGovernanceAuthorizedHandler(
  dependencies: GovernanceAuthorizedHandlerDependencies,
): GovernanceHttpServerOptions['handleAuthorizedRequest'] {
  const {
    governanceQueries,
    governanceResourceHandles,
    governancePreviewHandles,
    governance,
  } = dependencies;

  return async ({ actor, route, session, scope, resource, body }) => {
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_MEMORY_RECORDS_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryRecordResourceHandlePage(
              scope,
              ({ scope: recordScope, memoryId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_MEMORY_RECORDS_PURPOSE,
                resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
                resourceId: memoryId,
                scope: recordScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_MEMORY_RECORD_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getMemoryRecordDetailForScope({
            scope,
            memoryId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_MEMORY_RECORD_CONFIRM_PATH
          && resource?.kind === governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const isRestoreConfirmation = bodyKeys.length === 3
            && bodyKeys.includes('confirm')
            && bodyKeys.includes('previewHandle')
            && bodyKeys.includes('action')
            && bodyRecord?.confirm === true
            && bodyRecord.action === 'restore'
            && typeof previewHandle === 'string'
            && governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle);
          if (isRestoreConfirmation) {
            const consumed = governancePreviewHandles.consumeWithOutcome({
              sessionId: session.sessionId,
              handle: previewHandle,
              actor,
              action: MEMORY_RECORD_RESTORE_ACTION,
              resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
              resourceId: resource.resourceId,
              scope,
            });
            if (consumed.outcome === 'not_found_or_denied') {
              return { status: 404, body: { error: 'not_found' } };
            }
            if (consumed.outcome === 'already_consumed') {
              return { status: 409, body: { error: 'conflict' } };
            }

            const currentPreview = await governanceQueries.getMemoryRecordRestorePreviewForScope({
              scope,
              memoryId: resource.resourceId,
            });
            if (
              !currentPreview
              || scope.kind === 'tool'
              || consumed.binding.expectedState !== currentPreview.current.lifecycleState
              || consumed.binding.expectedRevisionNumber !== currentPreview.current.revisionNumber
              || consumed.binding.previewDigest !== currentPreview.previewDigest
            ) {
              return { status: 409, body: { error: 'conflict' } };
            }

            const result = governance.restoreMemoryAsLocalAdmin({
              memoryId: resource.resourceId,
              scope,
              expectedState: currentPreview.current.lifecycleState,
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              reasonCode: governanceContract.GOVERNANCE_HTTP_RESTORE_REASON,
            });
            if (result.outcome !== 'restored') {
              return result.outcome === 'not_found'
                ? { status: 404, body: { error: 'not_found' } }
                : { status: 409, body: { error: 'conflict' } };
            }
            return {
              status: 200,
              body: {
                action: MEMORY_RECORD_RESTORE_ACTION,
                outcome: 'restored',
                recordRef: currentPreview.recordRef,
                scopeKind: currentPreview.scopeKind,
                current: {
                  lifecycleState: 'active',
                  revisionNumber: result.revisionNumber,
                },
                durableEffects: [...currentPreview.expected.durableEffects],
                retrievalConsequences: [...currentPreview.expected.retrievalConsequences],
                evidence: {
                  changeType: 'restore',
                  revisionNumber: result.revisionNumber,
                  auditEvent: 'memory.restore',
                },
                rollback: { ...currentPreview.rollback },
              },
            };
          }
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
            action: MEMORY_RECORD_FORGET_ACTION,
            resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = await governanceQueries.getMemoryRecordForgetPreviewForScope({
            scope,
            memoryId: resource.resourceId,
          });
          if (
            !currentPreview
            || scope.kind === 'tool'
            || consumed.binding.expectedState !== currentPreview.current.lifecycleState
            || consumed.binding.expectedRevisionNumber !== currentPreview.current.revisionNumber
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          const result = governance.forgetMemoryAsLocalAdmin({
            memoryId: resource.resourceId,
            scope,
            expectedState: currentPreview.current.lifecycleState,
            expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
            reasonCode: governanceContract.GOVERNANCE_HTTP_FORGET_REASON,
          });
          if (result.outcome !== 'forgotten') {
            return result.outcome === 'not_found'
              ? { status: 404, body: { error: 'not_found' } }
              : { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: MEMORY_RECORD_FORGET_ACTION,
              outcome: 'forgotten',
              recordRef: currentPreview.recordRef,
              scopeKind: currentPreview.scopeKind,
              current: {
                lifecycleState: 'deleted',
                revisionNumber: result.revisionNumber,
              },
              durableEffects: [...currentPreview.expected.durableEffects],
              retrievalConsequences: [...currentPreview.expected.retrievalConsequences],
              evidence: {
                changeType: 'delete',
                revisionNumber: result.revisionNumber,
                auditEvent: 'memory.delete',
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_MEMORY_RECORD_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND
        ) {
          if (
            typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            && Object.keys(body).length === 1
            && (body as Record<string, unknown>).action === 'restore'
          ) {
            const preview = await governanceQueries.getMemoryRecordRestorePreviewForScope({
              scope,
              memoryId: resource.resourceId,
            });
            if (!preview) {
              return { status: 404, body: { error: 'not_found' } };
            }
            const issued = governancePreviewHandles.issue({
              sessionId: session.sessionId,
              sessionExpiresAt: session.expiresAt,
              actor,
              action: MEMORY_RECORD_RESTORE_ACTION,
              resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
              resourceId: resource.resourceId,
              scope,
              expectedState: preview.current.lifecycleState,
              expectedRevisionNumber: preview.current.revisionNumber,
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
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action !== 'forget'
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = await governanceQueries.getMemoryRecordForgetPreviewForScope({
            scope,
            memoryId: resource.resourceId,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: MEMORY_RECORD_FORGET_ACTION,
            resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
            expectedState: preview.current.lifecycleState,
            expectedRevisionNumber: preview.current.revisionNumber,
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
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_PRIVACY_PREFERENCE_CONFIRM_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const preferenceType = bodyRecord?.preferenceType;
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 4
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || !bodyKeys.includes('preferenceType')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || (preferenceType !== 'proactive_dm'
              && preferenceType !== 'memory_association')
            || (targetState !== 'opted_in' && targetState !== 'opted_out')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          if (scope.kind !== 'user') {
            return { status: 404, body: { error: 'not_found' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: PRIVACY_PREFERENCE_CHANGE_ACTION,
            resourceKind: governanceContract.GOVERNANCE_PRIVACY_PREFERENCE_RESOURCE_KIND,
            resourceId: preferenceType,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview =
            await governanceQueries.getPrivacyPreferenceChangePreviewForScope({
              scope,
              preferenceType,
              targetState,
            });
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.current.state
            || consumed.binding.expectedRevisionNumber
              !== Math.max(1, currentPreview.current.version.updatedAt ?? 1)
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          const result = governance.setPrivacyPreferenceAsLocalAdmin({
            canonicalUserId: scope.canonicalUserId,
            preferenceType: currentPreview.preferenceType,
            state: currentPreview.expected.state,
            expectedState: currentPreview.current.state,
            expectedVersion: currentPreview.current.version,
            reasonCode: governanceContract.GOVERNANCE_HTTP_PRIVACY_PREFERENCE_CHANGE_REASON,
          });
          if (result.outcome !== 'updated') {
            return result.outcome === 'not_found'
              ? { status: 404, body: { error: 'not_found' } }
              : { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: PRIVACY_PREFERENCE_CHANGE_ACTION,
              outcome: 'updated',
              preferenceType: currentPreview.preferenceType,
              current: {
                state: currentPreview.expected.state,
                version: {
                  source: 'stored_preference',
                  updatedAt: result.updatedAt,
                },
              },
              durableEffects: [...currentPreview.expected.durableEffects],
              enforcementConsequences: [
                ...currentPreview.expected.enforcementConsequences,
              ],
              evidence: {
                auditEvent: 'privacy.preference_set',
                updatedAt: result.updatedAt,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const preferenceType = bodyRecord?.preferenceType;
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('preferenceType')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.action !== 'change'
            || (preferenceType !== 'proactive_dm'
              && preferenceType !== 'memory_association')
            || (targetState !== 'opted_in' && targetState !== 'opted_out')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = await governanceQueries.getPrivacyPreferenceChangePreviewForScope({
            scope,
            preferenceType,
            targetState,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: PRIVACY_PREFERENCE_CHANGE_ACTION,
            resourceKind: governanceContract.GOVERNANCE_PRIVACY_PREFERENCE_RESOURCE_KIND,
            resourceId: preview.preferenceType,
            scope,
            expectedState: preview.current.state,
            expectedRevisionNumber: Math.max(1, preview.current.version.updatedAt ?? 1),
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
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listPrivacyPreferencesForScope(scope),
          };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_CONFIRM_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || (targetState !== 'enabled' && targetState !== 'disabled')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          if (scope.kind !== 'group') {
            return { status: 404, body: { error: 'not_found' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
            resourceKind: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_KIND,
            resourceId: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_ID,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview =
            await governanceQueries.getGroupSummaryPolicyChangePreviewForScope({
              scope,
              targetState,
            });
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.current.state
            || consumed.binding.expectedRevisionNumber
              !== (currentPreview.current.version.generation ?? 1)
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          let expectedVersion: GroupSummaryPolicyExpectedVersion;
          if (currentPreview.current.stored) {
            const { generation, updatedAt } = currentPreview.current.version;
            if (generation === null || updatedAt === null) {
              return { status: 409, body: { error: 'conflict' } };
            }
            expectedVersion = {
              source: 'stored_policy',
              generation,
              updatedAt: updatedAt.getTime(),
            };
          } else {
            expectedVersion = {
              source: 'implicit_default',
              generation: null,
              updatedAt: null,
            };
          }
          const result = governance.setGroupSummaryPolicyAsLocalAdmin({
            groupId: scope.groupId,
            enabled: currentPreview.expected.state === 'enabled',
            expectedState: currentPreview.current.state,
            expectedVersion,
            reasonCode: governanceContract.GOVERNANCE_HTTP_GROUP_SUMMARY_POLICY_CHANGE_REASON,
          });
          if (result.outcome !== 'updated') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const updatedAt = new Date(result.updatedAt);
          return {
            status: 200,
            body: {
              action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
              outcome: 'updated',
              current: {
                state: result.state,
                stored: true,
                version: {
                  generation: result.generation,
                  updatedAt,
                },
                eligibleAfter: result.eligibleAfter === null
                  ? null
                  : new Date(result.eligibleAfter),
              },
              durableEffects: [...currentPreview.expected.durableEffects],
              enforcementConsequences: [
                ...currentPreview.expected.enforcementConsequences,
              ],
              evidence: {
                auditEvent: 'group.summary_policy_changed',
                generation: result.generation,
                updatedAt,
                canceledJobCount: result.canceledJobCount,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.action !== 'change'
            || (targetState !== 'enabled' && targetState !== 'disabled')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = await governanceQueries.getGroupSummaryPolicyChangePreviewForScope({
            scope,
            targetState,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
            resourceKind: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_KIND,
            resourceId: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_ID,
            scope,
            expectedState: preview.current.state,
            expectedRevisionNumber: preview.current.version.generation ?? 1,
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
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_PATH
          && resource === undefined
        ) {
          const policy = await governanceQueries.getGroupSummaryPolicyForScope(scope);
          return policy
            ? { status: 200, body: policy }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listDisplayProfileTargetResourceHandlePage(
              scope,
              ({ scope: targetScope, targetId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
                resourceKind: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
                resourceId: targetId,
                scope: targetScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getDisplayProfileTargetDetailForScope({
            scope,
            targetId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_CONFIRM_PATH
          && resource?.kind === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND
        ) {
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
            action: DISPLAY_PROFILE_REDACTION_ACTION,
            resourceKind: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview =
            await governanceQueries.getDisplayProfileTargetRedactionPreviewForScope({
              scope,
              targetId: resource.resourceId,
            });
          if (
            !currentPreview
            || consumed.binding.expectedState
              !== currentPreview.current.snapshotFingerprint
            || consumed.binding.expectedRevisionNumber
              !== currentPreview.expected.affectedRows.total
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }
          const selection =
            await governanceQueries.resolveDisplayProfileTargetRedactionMutationForScope({
              scope,
              targetId: resource.resourceId,
            });
          if (!selection) {
            return { status: 409, body: { error: 'conflict' } };
          }
          const result = governance.redactDisplayProfileAsLocalAdmin({
            canonicalUserId: selection.canonicalUserId,
            ...(selection.groupId === null ? {} : { groupId: selection.groupId }),
            targetId: selection.targetId,
            expectedSnapshot: currentPreview.current,
            reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
          });
          if (result.outcome !== 'redacted') {
            return result.outcome === 'not_found'
              ? { status: 404, body: { error: 'not_found' } }
              : { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: DISPLAY_PROFILE_REDACTION_ACTION,
              outcome: 'redacted',
              target: currentPreview.target,
              affectedRows: {
                displayProfiles: result.displayProfilesUpdated,
                nicknameHistory: result.nicknameHistoryUpdated,
                total: result.displayProfilesUpdated + result.nicknameHistoryUpdated,
              },
              openNicknameHistoryRowsClosed: result.openNicknameHistoryRowsClosed,
              redactedAt: new Date(result.redactedAt),
              durableEffects: [...currentPreview.expected.durableEffects],
              privacyConsequences: [...currentPreview.expected.privacyConsequences],
              evidence: {
                auditEvent: 'display_profile.redact',
                reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND
        ) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action !== 'redact'
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview =
            await governanceQueries.getDisplayProfileTargetRedactionPreviewForScope({
              scope,
              targetId: resource.resourceId,
            });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: DISPLAY_PROFILE_REDACTION_ACTION,
            resourceKind: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
            expectedState: preview.current.snapshotFingerprint,
            expectedRevisionNumber: preview.expected.affectedRows.total,
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
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_EXPLAIN_TURNS_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listExplainTurnResourceHandlePage(
              scope,
              ({ scope: turnScope, turnId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
                resourceKind: governanceContract.GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND,
                resourceId: turnId,
                scope: turnScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_EXPLAIN_TURN_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getExplainTurnDetailForScope({
            scope,
            turnId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (route.path === governanceContract.GOVERNANCE_MEMORY_REVIEWS_PATH && resource === undefined) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryMaintenanceReviewResourceHandlePage(
              { scope },
              ({ scope: proposalScope, proposalId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: governanceContract.GOVERNANCE_MEMORY_REVIEW_PURPOSE,
                resourceKind: governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
                resourceId: proposalId,
                scope: proposalScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === governanceContract.GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getMemoryMaintenanceReview({
            scope,
            proposalId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_MEMORY_REVIEW_CONFIRM_PATH
          && resource?.kind === governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          if (!bodyRecord) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const bodyKeys = Object.keys(bodyRecord);
          const hasExactKeys = (keys: readonly string[]): boolean =>
            bodyKeys.length === keys.length && keys.every((key) => bodyKeys.includes(key));
          const previewHandle = bodyRecord.previewHandle;
          const retainedMemoryRef = bodyRecord.retainedMemoryRef;
          const isApprovalConfirmation = hasExactKeys(['confirm', 'previewHandle']);
          const isRejectionConfirmation = bodyRecord.action === 'reject'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          const isExpirationConfirmation = bodyRecord.action === 'expire'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          const isApplicationConfirmation = bodyRecord.action === 'apply'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          const isSelectedApplicationConfirmation = bodyRecord.action === 'apply'
            && hasExactKeys(['confirm', 'previewHandle', 'action', 'retainedMemoryRef'])
            && typeof retainedMemoryRef === 'string'
            && governanceContract.GOVERNANCE_REFERENCE_PATTERN.test(retainedMemoryRef);
          const isRollbackConfirmation = bodyRecord.action === 'rollback'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          if (
            bodyRecord.confirm !== true
            || typeof previewHandle !== 'string'
            || !governanceContract.GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || (
              !isApprovalConfirmation
              && !isRejectionConfirmation
              && !isExpirationConfirmation
              && !isApplicationConfirmation
              && !isSelectedApplicationConfirmation
              && !isRollbackConfirmation
            )
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const requestedAction = isApprovalConfirmation
            ? MEMORY_MAINTENANCE_APPROVAL_ACTION
            : isRejectionConfirmation
              ? MEMORY_MAINTENANCE_REJECTION_ACTION
              : isExpirationConfirmation
                ? MEMORY_MAINTENANCE_EXPIRATION_ACTION
                : isRollbackConfirmation
                  ? MEMORY_MAINTENANCE_ROLLBACK_ACTION
                  : MEMORY_MAINTENANCE_APPLICATION_ACTION;
          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: requestedAction,
            resourceKind: governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          let currentApplication: ResolvedMemoryMaintenanceApplication | null = null;
          if (requestedAction === MEMORY_MAINTENANCE_APPLICATION_ACTION) {
            currentApplication = await governanceQueries.resolveMemoryMaintenanceApplication({
              scope,
              proposalId: resource.resourceId,
              ...(isSelectedApplicationConfirmation
                ? { retainedMemoryRef: retainedMemoryRef as string }
              : {}),
            });
          }
          const currentRollback = requestedAction === MEMORY_MAINTENANCE_ROLLBACK_ACTION
            ? await governanceQueries.getMemoryMaintenanceRollbackPreview({
              scope,
              proposalId: resource.resourceId,
            })
            : null;
          const currentPreview = requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
            ? await governanceQueries.getMemoryMaintenanceApprovalPreview({
              scope,
              proposalId: resource.resourceId,
            })
            : requestedAction === MEMORY_MAINTENANCE_REJECTION_ACTION
              ? await governanceQueries.getMemoryMaintenanceRejectionPreview({
                scope,
                proposalId: resource.resourceId,
              })
              : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
                ? await governanceQueries.getMemoryMaintenanceExpirationPreview({
                  scope,
                  proposalId: resource.resourceId,
                })
                : requestedAction === MEMORY_MAINTENANCE_ROLLBACK_ACTION
                  ? currentRollback
                  : currentApplication?.preview ?? null;
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.current.lifecycleState
            || consumed.binding.expectedRevisionNumber !== currentPreview.current.revisionNumber
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          if (requestedAction === MEMORY_MAINTENANCE_APPLICATION_ACTION) {
            if (!currentApplication) {
              return { status: 409, body: { error: 'conflict' } };
            }
            const application = governance.applyMemoryMaintenanceProposal({
              authority: { kind: 'local_admin' },
              proposalId: resource.resourceId,
              expectedState: 'approved',
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              reasonCode: governanceContract.GOVERNANCE_HTTP_APPLICATION_REASON,
              ...(currentApplication.retainedMemoryId === undefined
                ? {}
                : { retainedMemoryId: currentApplication.retainedMemoryId }),
            });
            if (application.outcome === 'not_found_or_denied') {
              return { status: 404, body: { error: 'not_found' } };
            }
            if (application.outcome !== 'transitioned') {
              return { status: 409, body: { error: 'conflict' } };
            }
            const confirmation =
              governanceQueries.projectMemoryMaintenanceApplicationConfirmation({
                scope,
                proposal: application.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
                operation: currentApplication,
              });
            return confirmation
              ? { status: 200, body: confirmation }
              : { status: 503, body: { error: 'unavailable' } };
          }

          if (requestedAction === MEMORY_MAINTENANCE_ROLLBACK_ACTION) {
            if (!currentRollback) {
              return { status: 409, body: { error: 'conflict' } };
            }
            const rollback = governance.rollbackMemoryMaintenanceProposal({
              authority: { kind: 'local_admin' },
              proposalId: resource.resourceId,
              expectedState: 'applied',
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              reasonCode: governanceContract.GOVERNANCE_HTTP_ROLLBACK_REASON,
            });
            if (rollback.outcome === 'not_found_or_denied') {
              return { status: 404, body: { error: 'not_found' } };
            }
            if (rollback.outcome !== 'transitioned') {
              return { status: 409, body: { error: 'conflict' } };
            }
            const confirmation =
              governanceQueries.projectMemoryMaintenanceRollbackConfirmation({
                scope,
                proposal: rollback.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
                preview: currentRollback,
              });
            return confirmation
              ? { status: 200, body: confirmation }
              : { status: 503, body: { error: 'unavailable' } };
          }

          const review = governance.reviewMemoryMaintenanceProposal({
            authority: { kind: 'local_admin' },
            proposalId: resource.resourceId,
            expectedState: 'pending_review',
            expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
            transition: requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
              ? 'approve'
              : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
                ? 'expire'
                : 'reject',
            reasonCode: requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
              ? governanceContract.GOVERNANCE_HTTP_APPROVAL_REASON
              : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
                ? governanceContract.GOVERNANCE_HTTP_EXPIRATION_REASON
                : governanceContract.GOVERNANCE_HTTP_REJECTION_REASON,
          });
          if (review.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (review.outcome !== 'transitioned') {
            return { status: 409, body: { error: 'conflict' } };
          }
          const confirmation = requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
            ? governanceQueries.projectMemoryMaintenanceApprovalConfirmation({
              scope,
              proposal: review.proposal,
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
            })
            : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
              ? governanceQueries.projectMemoryMaintenanceExpirationConfirmation({
                scope,
                proposal: review.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              })
              : governanceQueries.projectMemoryMaintenanceRejectionConfirmation({
                scope,
                proposal: review.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              });
          return confirmation
            ? { status: 200, body: confirmation }
            : { status: 503, body: { error: 'unavailable' } };
        }
        if (
          route.method === 'POST'
          && route.path === governanceContract.GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH
          && resource?.kind === governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND
        ) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const bodyRecord = body as Record<string, unknown>;
          const bodyKeys = Object.keys(bodyRecord);
          const requestedAction = bodyRecord.action;
          const retainedMemoryRef = bodyRecord.retainedMemoryRef;
          const isApprovalRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'approve';
          const isRejectionRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'reject';
          const isExpirationRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'expire';
          const isApplicationWithoutSelection = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'apply';
          const isApplicationWithSelection = bodyKeys.length === 2
            && bodyKeys.includes('action')
            && bodyKeys.includes('retainedMemoryRef')
            && requestedAction === 'apply'
            && typeof retainedMemoryRef === 'string'
            && governanceContract.GOVERNANCE_REFERENCE_PATTERN.test(retainedMemoryRef);
          const isRollbackRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'rollback';
          if (
            !isApprovalRequest
            && !isRejectionRequest
            && !isExpirationRequest
            && !isApplicationWithoutSelection
            && !isApplicationWithSelection
            && !isRollbackRequest
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = isApprovalRequest
            ? await governanceQueries.getMemoryMaintenanceApprovalPreview({
              scope,
              proposalId: resource.resourceId,
            })
            : isRejectionRequest
              ? await governanceQueries.getMemoryMaintenanceRejectionPreview({
                scope,
                proposalId: resource.resourceId,
              })
              : isExpirationRequest
                ? await governanceQueries.getMemoryMaintenanceExpirationPreview({
                  scope,
                  proposalId: resource.resourceId,
                })
                : isRollbackRequest
                  ? await governanceQueries.getMemoryMaintenanceRollbackPreview({
                    scope,
                    proposalId: resource.resourceId,
                  })
                  : await governanceQueries.getMemoryMaintenanceApplicationPreview({
                    scope,
                    proposalId: resource.resourceId,
                    ...(isApplicationWithSelection
                      ? { retainedMemoryRef: retainedMemoryRef as string }
                      : {}),
                  });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: isApprovalRequest
              ? MEMORY_MAINTENANCE_APPROVAL_ACTION
              : isRejectionRequest
                ? MEMORY_MAINTENANCE_REJECTION_ACTION
                : isExpirationRequest
                  ? MEMORY_MAINTENANCE_EXPIRATION_ACTION
                  : isRollbackRequest
                    ? MEMORY_MAINTENANCE_ROLLBACK_ACTION
                    : MEMORY_MAINTENANCE_APPLICATION_ACTION,
            resourceKind: governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
            expectedState: preview.current.lifecycleState,
            expectedRevisionNumber: preview.current.revisionNumber,
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
        return { status: 404, body: { error: 'not_found' } };
  };
}
