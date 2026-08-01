import type Database from 'better-sqlite3';
import type { Config } from '../config/index.js';
import { GovernanceQueryService } from '../governance/query-service.js';
import { GovernanceOperationsCoordinator } from '../governance/operations-coordinator.js';
import type { GovernanceService } from '../governance/service.js';
import { GovernanceHttpServer } from './governance-http-server.js';
import { GovernancePreviewHandleRegistry } from './governance-preview-handle-registry.js';
import { GovernanceResourceHandleRegistry } from './governance-resource-handle-registry.js';
import { GovernanceScopeHandleRegistry } from './governance-scope-handle-registry.js';
import * as governanceContract from './governance-application-contracts.js';
import { createGovernanceAuthorizedHandler } from './governance-authorized-handler.js';
import { createGovernanceUnscopedHandler } from './governance-unscoped-handler.js';

export interface GovernanceApplicationDependencies {
  readonly config: Config;
  readonly db: Database.Database;
  readonly governance: GovernanceService;
}

export function createGovernanceApplication(
  dependencies: GovernanceApplicationDependencies,
): GovernanceHttpServer {
  const { config, db, governance } = dependencies;
    const governanceNow = (): number => Date.now();
    const governanceScopeHandles = new GovernanceScopeHandleRegistry({ now: governanceNow });
    const governanceResourceHandles = new GovernanceResourceHandleRegistry({ now: governanceNow });
    const governancePreviewHandles = new GovernancePreviewHandleRegistry({ now: governanceNow });
    const governanceQueries = new GovernanceQueryService(db);
    const governanceOperations = new GovernanceOperationsCoordinator({
      db,
      dbPath: config.dbPath,
      config: {
        onebotTransport: config.onebotTransport,
        onebotHttpUrl: config.onebotHttpUrl,
        onebotWsUrl: config.onebotWsUrl,
        onebotToken: config.onebotToken,
        onebotBotQqId: config.onebotBotQqId,
        lethebotHost: config.lethebotHost,
        lethebotPort: config.lethebotPort,
        lethebotHealthPath: config.lethebotHealthPath,
        lethebotReadinessPath: config.lethebotReadinessPath,
        lethebotMetricsPath: config.lethebotMetricsPath,
        lethebotEventPath: config.lethebotEventPath,
        rawEventRetentionDays: config.rawEventRetentionDays,
        chatMessageRetentionDays: config.chatMessageRetentionDays,
        auditLogRetentionDays: config.auditLogRetentionDays,
        disabledDeletedMemoryRetentionDays: config.disabledDeletedMemoryRetentionDays,
        eventProcessingFailureRetentionDays: config.eventProcessingFailureRetentionDays,
      },
      now: governanceNow,
    });
    return new GovernanceHttpServer({
      enabled: config.governanceEnabled,
      host: config.governanceHost,
      port: config.governancePort,
      adminToken: config.governanceAdminToken,
      sessionTtlMs: config.governanceSessionTtlMs,
      bodyLimitBytes: 4_096,
      bodyTimeoutMs: 5_000,
      now: governanceNow,
      authorizedRoutes: [{
        method: 'GET',
        path: governanceContract.GOVERNANCE_MEMORY_RECORDS_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_MEMORY_RECORD_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: false,
        resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_MEMORY_RECORD_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: true,
        resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_MEMORY_RECORD_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: true,
        resourceKind: governanceContract.GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PATH,
        purpose: governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_PATH,
        purpose: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PATH,
        purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: false,
        resourceKind: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: true,
        resourceKind: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: true,
        resourceKind: governanceContract.GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_PATH,
        purpose: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PATH,
        purpose: governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_PRIVACY_PREFERENCE_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
        mutation: true,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_EXPLAIN_TURNS_PATH,
        purpose: governanceContract.GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_EXPLAIN_TURN_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
        mutation: false,
        resourceKind: governanceContract.GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_MEMORY_REVIEWS_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: false,
        resourceKind: governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: true,
        resourceKind: governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_MEMORY_REVIEW_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: true,
        resourceKind: governanceContract.GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
      }],
      authenticatedUnscopedRoutes: [{
        method: 'GET',
        path: governanceContract.GOVERNANCE_SCOPES_PATH,
        purpose: governanceContract.GOVERNANCE_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_MEMORY_SCOPES_PATH,
        purpose: governanceContract.GOVERNANCE_MEMORY_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_PRIVACY_SCOPES_PATH,
        purpose: governanceContract.GOVERNANCE_PRIVACY_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_GROUP_SUMMARY_SCOPES_PATH,
        purpose: governanceContract.GOVERNANCE_GROUP_SUMMARY_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_DISPLAY_PROFILE_SCOPES_PATH,
        purpose: governanceContract.GOVERNANCE_DISPLAY_PROFILE_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PATH,
        purpose: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
        mutation: true,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_EXPLAIN_SCOPES_PATH,
        purpose: governanceContract.GOVERNANCE_EXPLAIN_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_OVERVIEW_PATH,
        purpose: governanceContract.GOVERNANCE_OVERVIEW_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_OPERATIONS_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_OPERATIONS_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_PREVIEW_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_OPERATIONS_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_BACKUP_CONFIRM_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_PREVIEW_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_PREVIEW_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PATH,
        purpose: governanceContract.GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PURPOSE,
        mutation: true,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_JOBS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_JOBS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_TOOL_CALLS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_TOOL_CALLS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: governanceContract.GOVERNANCE_ACTIVITY_AUDIT_PATH,
        purpose: governanceContract.GOVERNANCE_ACTIVITY_AUDIT_PURPOSE,
        mutation: false,
      }],
      scopeHandles: governanceScopeHandles,
      resourceHandles: governanceResourceHandles,
      previewHandles: governancePreviewHandles,
      handleAuthorizedRequest: createGovernanceAuthorizedHandler({
        governanceQueries,
        governanceResourceHandles,
        governancePreviewHandles,
        governance,
      }),
      handleAuthenticatedUnscopedRequest: createGovernanceUnscopedHandler({
        databasePath: config.dbPath,
        now: governanceNow,
        governanceQueries,
        governanceOperations,
        governanceScopeHandles,
        governanceResourceHandles,
        governancePreviewHandles,
        governance,
      }),
    });
}
