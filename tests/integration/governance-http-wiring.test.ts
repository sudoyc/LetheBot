import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../src/config/index.js';
import { GovernanceOperationsCoordinator } from '../../src/governance/operations-coordinator.js';
import { GovernanceService } from '../../src/governance/service.js';
import {
  GovernanceQueryService,
  type DisplayProfileTargetRedactionPreviewProjection,
  type ModelInvocationSummaryInspectionRecord,
} from '../../src/governance/query-service.js';
import { GovernancePreviewHandleRegistry } from '../../src/http/governance-preview-handle-registry.js';
import { GovernanceResourceHandleRegistry } from '../../src/http/governance-resource-handle-registry.js';
import { GovernanceScopeHandleRegistry } from '../../src/http/governance-scope-handle-registry.js';
import { LetheBotApp } from '../../src/index.js';
import { getLogger } from '../../src/logger/index.js';
import { createMemoryMaintenanceProposal } from '../../src/memory/maintenance-proposal.js';
import * as sqliteMaintenance from '../../src/operations/sqlite-maintenance.js';
import { readGovernanceRestoreHandoff } from '../../src/operations/governance-restore-handoff-reader.js';
import { AuditRepository } from '../../src/storage/audit-repository.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import { MemoryMaintenanceProposalRepository } from '../../src/storage/memory-maintenance-proposal-repository.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../../src/storage/privacy-preference-repository.js';

const ADMIN_TOKEN = 'synthetic-governance-admin-token-0001';
const SESSION_COOKIE = 'lethebot_governance_session';
const API_PREFIX = '/governance/api/v1';

describe('LetheBot governance HTTP lifecycle wiring', () => {
  const originalEnv = process.env;
  const apps: LetheBotApp[] = [];
  const occupiedServers: Server[] = [];
  const testDirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0).reverse()) {
      await app.stop();
    }
    for (const server of occupiedServers.splice(0).reverse()) {
      await closeServer(server);
    }
    for (const testDir of testDirs.splice(0)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('opens no governance listener when the feature is disabled', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const app = createTestApp(applicationPort, governancePort);
    apps.push(app);

    await app.start();
    await expect(fetchClosed(governancePort, `${API_PREFIX}/session`)).rejects.toThrow();
    await expect(fetchClosed(applicationPort, '/healthz')).resolves.toMatchObject({ status: 200 });
  });

  it('starts and stops the separate enabled listener with bounded discovery and overview', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const infoLog = vi.spyOn(getLogger(), 'info');
    const clearPreviewHandles = vi.spyOn(GovernancePreviewHandleRegistry.prototype, 'clear');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const origin = `http://127.0.0.1:${governancePort}`;
    const login = await fetch(`${origin}${API_PREFIX}/session`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(login.status).toBe(201);
    const cookie = extractCookie(login.headers);
    const loginBody = await login.text();
    expect(loginBody).not.toContain(ADMIN_TOKEN);

    const unauthenticatedScopes = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticatedScopes.status).toBe(401);
    expect(await unauthenticatedScopes.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const scopes = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: cookie },
    });
    expect(scopes.status).toBe(200);
    expect(await scopes.json()).toEqual({ entries: [], truncated: false });

    const unauthenticatedOverview = await fetch(`${origin}${API_PREFIX}/overview`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticatedOverview.status).toBe(401);
    expect(await unauthenticatedOverview.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const overview = await fetch(`${origin}${API_PREFIX}/overview`, {
      headers: { Connection: 'close', Cookie: cookie },
    });
    expect(overview.status).toBe(200);
    const overviewBody = await overview.json();
    expect(Number.isNaN(Date.parse(overviewBody.generatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(overviewBody.memoryReviews.generatedAt))).toBe(false);
    expect(overviewBody).toMatchObject({
      memoryReviews: {
        filters: { status: 'all' },
        total: 0,
        resolved: 0,
        unresolved: 0,
        byEventType: [
          { eventType: 'memory.conflict.detected', total: 0 },
          { eventType: 'memory.consolidation.candidates_detected', total: 0 },
          { eventType: 'memory.decay.candidates_detected', total: 0 },
        ],
      },
      eventProcessing: { failuresTotal: 0, byStage: {}, byConversationType: {} },
      actions: {
        decisions: { total: 0, evaluatorRequired: 0, evaluatorPassed: 0, evaluatorRejected: 0 },
        executions: { total: 0, failedOrRejected: 0 },
      },
      tools: { total: 0, secretsRedacted: 0, failedOrRejected: 0 },
      jobs: { total: 0, pending: 0, running: 0, failed: 0, expiredRunningLeases: 0 },
      workerHeartbeats: { total: 0, error: 0 },
      audit: { total: 0, highRisk: 0, prohibitedRisk: 0 },
      attention: {
        unresolvedMemoryReviews: 0,
        failedJobs: 0,
        expiredRunningLeases: 0,
        errorWorkerHeartbeats: 0,
        failedOrRejectedActions: 0,
        failedOrRejectedToolCalls: 0,
        eventProcessingFailures: 0,
        highOrProhibitedRiskAuditEvents: 0,
      },
    });
    expect(Object.keys(overviewBody).sort()).toEqual([
      'actions',
      'attention',
      'audit',
      'eventProcessing',
      'generatedAt',
      'jobs',
      'memoryReviews',
      'tools',
      'workerHeartbeats',
    ]);
    const scopedDomainRouteWithoutHandle = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: { Connection: 'close', Cookie: cookie },
    });
    expect(scopedDomainRouteWithoutHandle.status).toBe(400);
    expect(await scopedDomainRouteWithoutHandle.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(await fetchClosed(applicationPort, '/healthz')).toMatchObject({ status: 200 });
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain(ADMIN_TOKEN);

    await app.stop();
    expect(clearPreviewHandles).toHaveBeenCalledTimes(1);
    await expect(fetchClosed(applicationPort, '/healthz')).rejects.toThrow();
    await expect(fetchClosed(governancePort, `${API_PREFIX}/session`)).rejects.toThrow();

    const restarted = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(restarted);
    await restarted.start();
    const staleSession = await fetch(`${origin}${API_PREFIX}/session`, {
      headers: { Connection: 'close', Cookie: cookie },
    });
    expect(staleSession.status).toBe(401);
    await restarted.stop();
    expect(clearPreviewHandles).toHaveBeenCalledTimes(2);
    expect(new Set(clearPreviewHandles.mock.instances)).toHaveProperty('size', 2);
  });

  it('serves the fixed Operations status only through authenticated unscoped access', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const inspect = vi.spyOn(GovernanceOperationsCoordinator.prototype, 'inspect');
    const createBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'createVerifiedBackup',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/operations`;

    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(inspect).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const withQuery = await fetch(`${origin}${path}?include=raw`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(inspect).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-must-not-be-accepted',
      },
    });
    expect(withScope.status).toBe(400);
    expect(inspect).not.toHaveBeenCalled();

    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      generatedAt: string;
      overall: string;
      database: Record<string, unknown>;
      schema: Record<string, unknown>;
      counts: Record<string, unknown>;
      configuration: Record<string, unknown>;
      workflows: Record<string, unknown>;
    };
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.overall).toBe('ok');
    expect(body.database).toEqual({
      open: true,
      readonly: true,
      integrity: 'ok',
      foreignKeys: 'clean',
    });
    expect(body.schema).toEqual({
      ready: true,
      requiredTablesPresent: 25,
      requiredTablesTotal: 25,
      missingTableCount: 0,
    });
    expect(Object.keys(body.counts)).toEqual([
      'rawEvents',
      'eventIngressReceipts',
      'eventProcessingAdmissions',
      'chatMessages',
      'eventProcessingFailures',
      'agentTurns',
      'contextTraces',
      'actionDecisions',
      'actionExecutions',
      'memoryRecords',
      'memorySources',
      'memoryRevisions',
      'toolCalls',
      'auditLog',
      'jobs',
      'jobAttempts',
      'workerHeartbeats',
    ]);
    expect(body.workflows).toEqual({
      backup: { available: true },
      restore: { available: true, executionBoundary: 'stopped_service_only' },
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(createBackup).not.toHaveBeenCalled();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(ADMIN_TOKEN);
    expect(raw).not.toContain('onebot');
    expect(raw).not.toContain('governance-wiring-');
    expect(raw).not.toContain('integrity diagnostic');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(createBackup).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues a verified-backup preview only through authenticated unscoped mutation access', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const inspect = vi.spyOn(GovernanceOperationsCoordinator.prototype, 'inspect');
    const previewBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'previewVerifiedBackup',
    );
    const createBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'createVerifiedBackup',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const databaseDirectory = testDirs.at(-1);
    if (!databaseDirectory) {
      throw new Error('Expected synthetic governance database directory');
    }

    await app.start();
    const db = app.getDatabase();
    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/operations`;
    const requestBody = JSON.stringify({ action: 'create_verified_backup' });
    const filesBefore = readdirSync(databaseDirectory).sort();
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const unauthenticated = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(previewBackup).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual(filesBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken,
      'Content-Type': 'application/json',
    };

    const missingCsrf = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(missingCsrf.status).toBe(403);
    const missingOrigin = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-CSRF': session.csrfToken,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(missingOrigin.status).toBe(403);
    const wrongOrigin = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...mutationHeaders, Origin: 'http://127.0.0.1:1' },
      body: requestBody,
    });
    expect(wrongOrigin.status).toBe(403);
    const wrongCsrf = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-CSRF': 'x'.repeat(43) },
      body: requestBody,
    });
    expect(wrongCsrf.status).toBe(403);
    const missingContentType = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': session.csrfToken,
      },
      body: requestBody,
    });
    expect(missingContentType.status).toBe(400);
    const queried = await fetch(`${origin}${path}?destination=client-selected`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody,
    });
    expect(queried.status).toBe(400);
    const scoped = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'X-LetheBot-Scope': 'scope-must-not-be-accepted',
      },
      body: requestBody,
    });
    expect(scoped.status).toBe(400);
    const malformedJson = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    const oversized = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: 'x'.repeat(4_097),
    });
    expect(oversized.status).toBe(413);
    for (const body of [
      null,
      [],
      {},
      { action: 'backup' },
      { action: 'create_verified_backup', backupPath: '/tmp/client-selected' },
      { action: 'create_verified_backup', extra: true },
    ]) {
      const invalid = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(previewBackup).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody,
    });
    expect(response.status).toBe(201);
    const preview = await response.json() as {
      action: string;
      currentState: string;
      contractVersion: number;
      effects: Record<string, unknown>;
      restore: Record<string, unknown>;
      rollback: Record<string, unknown>;
      previewDigest: string;
      previewHandle: string;
      previewExpiresAt: number;
    };
    expect(preview).toEqual({
      action: 'create_verified_backup',
      currentState: 'available',
      contractVersion: 1,
      effects: {
        databaseMutation: false,
        privateArtifactCreation: true,
        integrityVerification: true,
        destinationOverwrite: false,
      },
      restore: {
        availableAfterCompletion: true,
        executionBoundary: 'stopped_service_only',
      },
      rollback: {
        available: false,
        reason: 'artifact_removal_not_exposed',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: expect.any(Number),
    });
    expect(Number.isSafeInteger(preview.previewExpiresAt)).toBe(true);
    expect(preview.previewExpiresAt).toBeGreaterThan(Date.now());
    expect(preview.previewExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(previewBackup).toHaveBeenCalledTimes(1);
    expect(previewBackup).toHaveBeenCalledWith();
    expect(issuePreviewHandle).toHaveBeenCalledTimes(1);
    expect(issuePreviewHandle).toHaveBeenCalledWith({
      sessionId: sessionDigest,
      sessionExpiresAt: expect.any(Number),
      actor: { kind: 'local_admin' },
      action: 'create_verified_backup',
      resourceKind: 'operations_verified_backup',
      resourceId: 'verified_backup',
      scope: { kind: 'system' },
      expectedState: 'available',
      expectedRevisionNumber: 1,
      previewDigest: preview.previewDigest,
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();

    const repeated = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody,
    });
    expect(repeated.status).toBe(201);
    const repeatedPreview = await repeated.json() as typeof preview;
    expect(repeatedPreview.previewDigest).toBe(preview.previewDigest);
    expect(repeatedPreview.previewHandle).not.toBe(preview.previewHandle);
    expect(previewBackup).toHaveBeenCalledTimes(2);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(2);

    const status = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(status.status).toBe(200);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(previewBackup).toHaveBeenCalledTimes(2);
    expect(createBackup).not.toHaveBeenCalled();

    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual(filesBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews and confirms configured retention through one system-scoped authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    await app.start();
    const origin = `http://127.0.0.1:${governancePort}`;
    const session = await loginGovernance(origin);
    const headers = {
      Connection: 'close', Cookie: session.cookie, Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken, 'Content-Type': 'application/json',
    };
    const path = `${API_PREFIX}/operations/retention`;

    for (const body of [{}, { action: 'apply_configured_retention', extra: true }]) {
      const invalid = await fetch(`${origin}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
    }
    const previewResponse = await fetch(`${origin}${path}`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'apply_configured_retention' }),
    });
    expect(previewResponse.status).toBe(201);
    const preview = await previewResponse.json() as Record<string, unknown>;
    expect(preview).toMatchObject({
      action: 'apply_configured_retention', contractVersion: 1,
      memoryStates: ['rejected', 'disabled', 'deleted'], zeroMeansForever: true,
      irreversible: {
        hardDelete: true, rollbackAvailable: false,
        boundary: 'verified_backup_recommended',
      },
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: expect.any(Number),
    });
    const serializedPreview = JSON.stringify(preview);
    for (const forbidden of ['candidates', 'candidateFingerprints', 'rawEventIds', 'chatMessageIds', 'SELECT ', 'DELETE ']) {
      expect(serializedPreview).not.toContain(forbidden);
    }

    const confirmBody = JSON.stringify({
      confirm: true,
      previewHandle: preview.previewHandle,
    });
    const confirmed = await fetch(`${origin}${path}/confirm`, {
      method: 'POST', headers, body: confirmBody,
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      action: 'apply_configured_retention', status: 'applied', contractVersion: 1,
      memoryStates: ['rejected', 'disabled', 'deleted'], zeroMeansForever: true,
    });
    const replay = await fetch(`${origin}${path}/confirm`, {
      method: 'POST', headers, body: confirmBody,
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).toBe(JSON.stringify({ error: 'conflict' }));
    const audit = app.getDatabase().prepare(
      "SELECT details, redacted, risk_level FROM audit_log WHERE event_type = 'operations.retention.applied'",
    ).get() as { details: string; redacted: number; risk_level: string };
    expect(audit.redacted).toBe(1);
    expect(audit.risk_level).toBe('high');
    expect(audit.details).not.toContain(String(preview.previewHandle));
  });

  it('confirms one verified backup through current-session authority without a client path', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const inspect = vi.spyOn(GovernanceOperationsCoordinator.prototype, 'inspect');
    const previewBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'previewVerifiedBackup',
    );
    const createManagedBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'createServerOwnedVerifiedBackup',
    );
    const createBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'createVerifiedBackup',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const databaseDirectory = testDirs.at(-1);
    if (!databaseDirectory) {
      throw new Error('Expected synthetic governance database directory');
    }

    await app.start();
    const db = app.getDatabase();
    const origin = `http://127.0.0.1:${governancePort}`;
    const previewPath = `${API_PREFIX}/operations`;
    const confirmPath = `${previewPath}/confirm`;
    const filesBefore = readdirSync(databaseDirectory).sort();
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const auditCountBefore = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();
    const placeholderHandle = 'x'.repeat(43);

    const unauthenticated = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirm: true, previewHandle: placeholderHandle }),
    });
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(createManagedBackup).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual(filesBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken,
      'Content-Type': 'application/json',
    };
    const placeholderBody = JSON.stringify({
      confirm: true,
      previewHandle: placeholderHandle,
    });

    const missingCsrf = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: placeholderBody,
    });
    expect(missingCsrf.status).toBe(403);
    const missingOrigin = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-CSRF': session.csrfToken,
        'Content-Type': 'application/json',
      },
      body: placeholderBody,
    });
    expect(missingOrigin.status).toBe(403);
    const wrongOrigin = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, Origin: 'http://127.0.0.1:1' },
      body: placeholderBody,
    });
    expect(wrongOrigin.status).toBe(403);
    const wrongCsrf = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-CSRF': 'z'.repeat(43) },
      body: placeholderBody,
    });
    expect(wrongCsrf.status).toBe(403);
    const missingContentType = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': session.csrfToken,
      },
      body: placeholderBody,
    });
    expect(missingContentType.status).toBe(400);
    const queried = await fetch(`${origin}${confirmPath}?destination=client-selected`, {
      method: 'POST',
      headers: mutationHeaders,
      body: placeholderBody,
    });
    expect(queried.status).toBe(400);
    const scoped = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'X-LetheBot-Scope': 'scope-must-not-be-accepted',
      },
      body: placeholderBody,
    });
    expect(scoped.status).toBe(400);
    const malformedJson = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    const oversized = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: 'x'.repeat(4_097),
    });
    expect(oversized.status).toBe(413);
    for (const body of [
      null,
      [],
      {},
      { confirm: false, previewHandle: placeholderHandle },
      { confirm: true },
      { confirm: true, previewHandle: 'short' },
      { confirm: true, previewHandle: placeholderHandle, action: 'create_verified_backup' },
      { confirm: true, previewHandle: placeholderHandle, backupPath: '/tmp/client-selected' },
    ]) {
      const invalid = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(previewBackup).not.toHaveBeenCalled();
    expect(createManagedBackup).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual(filesBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);

    const issuePreview = async (headers: typeof mutationHeaders) => {
      const response = await fetch(`${origin}${previewPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'create_verified_backup' }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{
        action: 'create_verified_backup';
        currentState: 'available';
        contractVersion: 1;
        effects: {
          databaseMutation: false;
          privateArtifactCreation: true;
          integrityVerification: true;
          destinationOverwrite: false;
        };
        restore: {
          availableAfterCompletion: true;
          executionBoundary: 'stopped_service_only';
        };
        rollback: {
          available: false;
          reason: 'artifact_removal_not_exposed';
        };
        previewDigest: string;
        previewHandle: string;
        previewExpiresAt: number;
      }>;
    };
    const confirm = (headers: typeof mutationHeaders, previewHandle: string) => (
      fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ confirm: true, previewHandle }),
      })
    );

    const stalePreview = await issuePreview(mutationHeaders);
    const secondSession = await loginGovernance(origin);
    const secondHeaders = {
      ...mutationHeaders,
      Cookie: secondSession.cookie,
      'X-LetheBot-CSRF': secondSession.csrfToken,
    };
    const crossSession = await confirm(secondHeaders, stalePreview.previewHandle);
    expect(crossSession.status).toBe(404);
    expect(await crossSession.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const unknown = await confirm(mutationHeaders, 'u'.repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(createManagedBackup).not.toHaveBeenCalled();

    previewBackup.mockReturnValueOnce({
      action: 'create_verified_backup',
      currentState: 'available',
      contractVersion: 1,
      effects: {
        databaseMutation: false,
        privateArtifactCreation: true,
        integrityVerification: true,
        destinationOverwrite: false,
      },
      restore: {
        availableAfterCompletion: true,
        executionBoundary: 'stopped_service_only',
      },
      rollback: {
        available: false,
        reason: 'artifact_removal_not_exposed',
      },
      previewDigest: '0'.repeat(64),
    });
    const stale = await confirm(mutationHeaders, stalePreview.previewHandle);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(createManagedBackup).not.toHaveBeenCalled();
    const consumedStale = await confirm(mutationHeaders, stalePreview.previewHandle);
    expect(consumedStale.status).toBe(409);
    expect(await consumedStale.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(createManagedBackup).not.toHaveBeenCalled();

    const currentPreview = await issuePreview(mutationHeaders);
    const completedResponse = await confirm(mutationHeaders, currentPreview.previewHandle);
    expect(completedResponse.status).toBe(200);
    const completedText = await completedResponse.text();
    const completed = JSON.parse(completedText) as {
      status: string;
      artifact: { integrity: string; sizeBytes: number };
      pages: { total: number; remaining: number; complete: boolean };
      restore: { available: boolean; executionBoundary: string };
      backupRef: string | null;
    };
    expect(completed).toEqual({
      status: 'completed',
      artifact: {
        integrity: 'verified',
        sizeBytes: expect.any(Number),
      },
      pages: {
        total: expect.any(Number),
        remaining: 0,
        complete: true,
      },
      restore: {
        available: true,
        executionBoundary: 'stopped_service_only',
      },
      backupRef: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(completed.artifact.sizeBytes).toBeGreaterThan(0);
    expect(completed.pages.total).toBeGreaterThan(0);
    expect(Object.keys(completed).sort()).toEqual([
      'artifact',
      'backupRef',
      'pages',
      'restore',
      'status',
    ]);
    expect(completed.backupRef).not.toBeNull();
    const backupRef = completed.backupRef ?? '';
    const backupDirectory = join(databaseDirectory, '.lethebot-governance-backups');
    const backupFile = join(backupDirectory, `${backupRef}.db`);
    expect(readdirSync(databaseDirectory).sort()).toEqual([
      ...filesBefore,
      '.lethebot-governance-backups',
    ].sort());
    expect(readdirSync(backupDirectory)).toEqual([`${backupRef}.db`]);
    expect(lstatSync(backupDirectory).mode & 0o7777).toBe(0o700);
    expect(lstatSync(backupFile).mode & 0o7777).toBe(0o600);
    expect(lstatSync(backupFile).size).toBe(completed.artifact.sizeBytes);
    expect(completedText).not.toContain(databaseDirectory);
    expect(completedText).not.toContain('.lethebot-governance-backups');
    expect(completedText).not.toContain('.db');
    expect(completedText).not.toContain(ADMIN_TOKEN);
    expect(inspect).not.toHaveBeenCalled();
    expect(createManagedBackup).toHaveBeenCalledTimes(1);
    expect(createManagedBackup).toHaveBeenCalledWith();
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(createBackup).toHaveBeenCalledWith({ backupPath: backupFile });
    expect(consumePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: sessionDigest,
      handle: currentPreview.previewHandle,
      actor: { kind: 'local_admin' },
      action: 'create_verified_backup',
      resourceKind: 'operations_verified_backup',
      resourceId: 'verified_backup',
      scope: { kind: 'system' },
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditCountBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const repeated = await confirm(mutationHeaders, currentPreview.previewHandle);
    expect(repeated.status).toBe(409);
    expect(await repeated.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(createManagedBackup).toHaveBeenCalledTimes(1);
    expect(readdirSync(backupDirectory)).toEqual([`${backupRef}.db`]);

    const attentionPreview = await issuePreview(mutationHeaders);
    createManagedBackup.mockResolvedValueOnce({
      status: 'attention_required',
      artifact: { integrity: 'attention_required', sizeBytes: 0 },
      pages: { total: 0, remaining: 0, complete: false },
      restore: { available: false, executionBoundary: 'stopped_service_only' },
      backupRef: null,
    });
    const attentionResponse = await confirm(mutationHeaders, attentionPreview.previewHandle);
    expect(attentionResponse.status).toBe(200);
    expect(await attentionResponse.json()).toEqual({
      status: 'attention_required',
      artifact: { integrity: 'attention_required', sizeBytes: 0 },
      pages: { total: 0, remaining: 0, complete: false },
      restore: { available: false, executionBoundary: 'stopped_service_only' },
      backupRef: null,
    });
    expect(createManagedBackup).toHaveBeenCalledTimes(2);
    expect(createBackup).toHaveBeenCalledTimes(1);
    const repeatedAttention = await confirm(mutationHeaders, attentionPreview.previewHandle);
    expect(repeatedAttention.status).toBe(409);
    expect(createManagedBackup).toHaveBeenCalledTimes(2);
    expect(readdirSync(backupDirectory)).toEqual([`${backupRef}.db`]);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditCountBefore);

    const absentRestoreExecution = await fetch(`${origin}${previewPath}/restore/execute`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ confirm: true, backupRef }),
    });
    expect(absentRestoreExecution.status).toBe(404);
  });

  it('issues exact-reference restore-handoff authority without exposing a path or restore effect', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const previewRestore = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'previewServerOwnedBackupRestore',
    );
    const previewBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'previewVerifiedBackup',
    );
    const createManagedBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'createServerOwnedVerifiedBackup',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const restore = vi.spyOn(sqliteMaintenance, 'restoreSqliteDatabase');
    const retention = vi.spyOn(sqliteMaintenance, 'applyRetentionPolicy');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const databaseDirectory = testDirs.at(-1);
    if (!databaseDirectory) {
      throw new Error('Expected synthetic governance database directory');
    }

    await app.start();
    const db = app.getDatabase();
    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/operations/restore`;
    const placeholderRef = 'r'.repeat(43);
    const requestBody = JSON.stringify({
      action: 'prepare_restore_handoff',
      backupRef: placeholderRef,
    });
    const filesBefore = readdirSync(databaseDirectory).sort();
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const unauthenticated = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(previewRestore).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(createManagedBackup).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual(filesBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken,
      'Content-Type': 'application/json',
    };
    const missingCsrf = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(missingCsrf.status).toBe(403);
    const missingOrigin = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-CSRF': session.csrfToken,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(missingOrigin.status).toBe(403);
    const queried = await fetch(`${origin}${path}?backupRef=${placeholderRef}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody,
    });
    expect(queried.status).toBe(400);
    const scoped = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'X-LetheBot-Scope': 'scope-must-not-be-accepted',
      },
      body: requestBody,
    });
    expect(scoped.status).toBe(400);
    const malformedJson = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    const missingContentType = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': session.csrfToken,
      },
      body: requestBody,
    });
    expect(missingContentType.status).toBe(400);
    const oversized = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: 'x'.repeat(4_097),
    });
    expect(oversized.status).toBe(413);
    for (const body of [
      null,
      [],
      {},
      { action: 'restore', backupRef: placeholderRef },
      { action: 'prepare_restore_handoff' },
      { action: 'prepare_restore_handoff', backupRef: 'short' },
      { action: 'prepare_restore_handoff', backupRef: `${'a'.repeat(42)}=` },
      { action: 'prepare_restore_handoff', backupRef: placeholderRef, extra: true },
      { action: 'prepare_restore_handoff', backupRef: placeholderRef, path: '/tmp/hidden' },
    ]) {
      const invalid = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(previewRestore).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(createManagedBackup).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();

    const backupPreviewResponse = await fetch(`${origin}${API_PREFIX}/operations`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'create_verified_backup' }),
    });
    expect(backupPreviewResponse.status).toBe(201);
    const backupPreview = await backupPreviewResponse.json() as { previewHandle: string };
    const backupResponse = await fetch(`${origin}${API_PREFIX}/operations/confirm`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ confirm: true, previewHandle: backupPreview.previewHandle }),
    });
    expect(backupResponse.status).toBe(200);
    const backup = await backupResponse.json() as {
      status: string;
      backupRef: string | null;
    };
    expect(backup).toMatchObject({
      status: 'completed',
      backupRef: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const backupRef = backup.backupRef ?? '';
    const backupDirectory = join(databaseDirectory, '.lethebot-governance-backups');
    const backupFile = join(backupDirectory, `${backupRef}.db`);
    const backupBytes = readFileSync(backupFile);
    const filesAfterBackup = readdirSync(backupDirectory).sort();
    const changesAfterBackup = db.prepare('SELECT total_changes()').pluck().get();
    const auditCountAfterBackup = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();
    const issuedBeforeRestore = issuePreviewHandle.mock.calls.length;
    const consumedBeforeRestore = consumePreviewHandle.mock.calls.length;

    const missingRef = 'Z'.repeat(43);
    expect(missingRef).not.toBe(backupRef);
    const missing = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        action: 'prepare_restore_handoff',
        backupRef: missingRef,
      }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(previewRestore).toHaveBeenCalledTimes(1);
    expect(previewRestore).toHaveBeenCalledWith(missingRef);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(issuedBeforeRestore);

    const issueRestorePreview = async () => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          action: 'prepare_restore_handoff',
          backupRef,
        }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{
        action: 'prepare_restore_handoff';
        currentState: 'verified_backup_available';
        contractVersion: 1;
        artifact: { integrity: 'verified'; sizeBytes: number };
        effects: {
          databaseMutation: false;
          artifactMutation: false;
          restoreExecution: false;
          serviceStopRequired: true;
        };
        restore: { available: true; executionBoundary: 'stopped_service_only' };
        rollback: { available: false; reason: 'no_in_process_effect' };
        previewDigest: string;
        previewHandle: string;
        previewExpiresAt: number;
      }>;
    };
    const preview = await issueRestorePreview();
    expect(preview).toEqual({
      action: 'prepare_restore_handoff',
      currentState: 'verified_backup_available',
      contractVersion: 1,
      artifact: {
        integrity: 'verified',
        sizeBytes: backupBytes.length,
      },
      effects: {
        databaseMutation: false,
        artifactMutation: false,
        restoreExecution: false,
        serviceStopRequired: true,
      },
      restore: {
        available: true,
        executionBoundary: 'stopped_service_only',
      },
      rollback: {
        available: false,
        reason: 'no_in_process_effect',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: expect.any(Number),
    });
    expect(preview.previewExpiresAt).toBeGreaterThan(Date.now());
    expect(preview.previewExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(previewRestore).toHaveBeenCalledTimes(2);
    expect(previewRestore).toHaveBeenLastCalledWith(backupRef);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(issuedBeforeRestore + 1);
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: sessionDigest,
      sessionExpiresAt: expect.any(Number),
      actor: { kind: 'local_admin' },
      action: 'prepare_restore_handoff',
      resourceKind: 'operations_backup_restore',
      resourceId: backupRef,
      scope: { kind: 'system' },
      expectedState: 'verified_backup_available',
      expectedRevisionNumber: 1,
      previewDigest: preview.previewDigest,
    });
    const previewRaw = JSON.stringify(preview);
    expect(previewRaw).not.toContain(backupRef);
    expect(previewRaw).not.toContain(databaseDirectory);
    expect(previewRaw).not.toContain('.lethebot-governance-backups');
    expect(previewRaw).not.toContain('.db');
    expect(previewRaw).not.toContain(ADMIN_TOKEN);
    expect(previewRaw).not.toContain('diagnostic');

    const repeated = await issueRestorePreview();
    expect(repeated.previewDigest).toBe(preview.previewDigest);
    expect(repeated.previewHandle).not.toBe(preview.previewHandle);
    expect(previewRestore).toHaveBeenCalledTimes(3);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(issuedBeforeRestore + 2);

    const wrongConfirmation = await fetch(`${origin}${API_PREFIX}/operations/confirm`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ confirm: true, previewHandle: preview.previewHandle }),
    });
    expect(wrongConfirmation.status).toBe(404);
    expect(await wrongConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const absentExecution = await fetch(`${origin}${path}/execute`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ confirm: true, previewHandle: preview.previewHandle }),
    });
    expect(absentExecution.status).toBe(404);
    expect(createManagedBackup).toHaveBeenCalledTimes(1);
    expect(previewBackup).toHaveBeenCalledTimes(2);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(consumedBeforeRestore + 1);
    expect(restore).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
    expect(readdirSync(backupDirectory).sort()).toEqual(filesAfterBackup);
    expect(readFileSync(backupFile)).toEqual(backupBytes);
    expect(lstatSync(backupDirectory).mode & 0o7777).toBe(0o700);
    expect(lstatSync(backupFile).mode & 0o7777).toBe(0o600);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterBackup);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditCountAfterBackup);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('confirms one restore handoff through exact current-session authority without executing restore', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const backupRef = 'h'.repeat(43);
    let currentDigest = '1'.repeat(64);
    const restorePreview = () => ({
      action: 'prepare_restore_handoff',
      currentState: 'verified_backup_available',
      contractVersion: 1,
      artifact: { integrity: 'verified', sizeBytes: 4_096 },
      effects: {
        databaseMutation: false,
        artifactMutation: false,
        restoreExecution: false,
        serviceStopRequired: true,
      },
      restore: { available: true, executionBoundary: 'stopped_service_only' },
      rollback: { available: false, reason: 'no_in_process_effect' },
      previewDigest: currentDigest,
    } as const);
    const previewRestore = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'previewServerOwnedBackupRestore',
    ).mockImplementation((requestedRef) => (
      requestedRef === backupRef ? restorePreview() : null
    ));
    const createManagedBackup = vi.spyOn(
      GovernanceOperationsCoordinator.prototype,
      'createServerOwnedVerifiedBackup',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const restore = vi.spyOn(sqliteMaintenance, 'restoreSqliteDatabase');
    const retention = vi.spyOn(sqliteMaintenance, 'applyRetentionPolicy');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const databaseDirectory = testDirs.at(-1);
    if (!databaseDirectory) {
      throw new Error('Expected synthetic governance database directory');
    }

    await app.start();
    const db = app.getDatabase();
    const origin = `http://127.0.0.1:${governancePort}`;
    const previewPath = `${API_PREFIX}/operations/restore`;
    const confirmPath = `${previewPath}/confirm`;
    const placeholderHandle = 'p'.repeat(43);
    const requestBody = JSON.stringify({
      confirm: true,
      previewHandle: placeholderHandle,
      backupRef,
    });
    const filesBefore = readdirSync(databaseDirectory).sort();
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const auditsBefore = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();

    const unauthenticated = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(previewRestore).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(createManagedBackup).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual(filesBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken,
      'Content-Type': 'application/json',
    };
    const missingCsrf = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(missingCsrf.status).toBe(403);
    const missingOrigin = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-CSRF': session.csrfToken,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    expect(missingOrigin.status).toBe(403);
    const queried = await fetch(`${origin}${confirmPath}?confirm=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody,
    });
    expect(queried.status).toBe(400);
    const scoped = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'X-LetheBot-Scope': 'scope-must-not-be-accepted',
      },
      body: requestBody,
    });
    expect(scoped.status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { confirm: false, previewHandle: placeholderHandle, backupRef },
      { confirm: true, previewHandle: 'short', backupRef },
      { confirm: true, previewHandle: placeholderHandle },
      { confirm: true, previewHandle: placeholderHandle, backupRef: 'short' },
      { confirm: true, previewHandle: placeholderHandle, backupRef, path: '/tmp/hidden' },
    ]) {
      const invalid = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(previewRestore).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();

    const issueRestorePreview = async () => {
      const response = await fetch(`${origin}${previewPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ action: 'prepare_restore_handoff', backupRef }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{
        previewHandle: string;
        previewDigest: string;
      }>;
    };
    const confirm = (
      headers: Record<string, string>,
      previewHandle: string,
      requestedRef = backupRef,
    ) => fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirm: true, previewHandle, backupRef: requestedRef }),
    });

    const currentPreview = await issueRestorePreview();
    expect(currentPreview.previewDigest).toBe(currentDigest);
    const wrongRef = await confirm(mutationHeaders, currentPreview.previewHandle, 'w'.repeat(43));
    expect(wrongRef.status).toBe(404);
    expect(await wrongRef.text()).toBe(JSON.stringify({ error: 'not_found' }));

    const secondSession = await loginGovernance(origin);
    const secondHeaders = {
      Connection: 'close',
      Cookie: secondSession.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': secondSession.csrfToken,
      'Content-Type': 'application/json',
    };
    const crossSession = await confirm(secondHeaders, currentPreview.previewHandle);
    expect(crossSession.status).toBe(404);
    const unknown = await confirm(mutationHeaders, 'u'.repeat(43));
    expect(unknown.status).toBe(404);

    const backupPreviewResponse = await fetch(`${origin}${API_PREFIX}/operations`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'create_verified_backup' }),
    });
    expect(backupPreviewResponse.status).toBe(201);
    const backupPreview = await backupPreviewResponse.json() as { previewHandle: string };
    const wrongAction = await confirm(mutationHeaders, backupPreview.previewHandle);
    expect(wrongAction.status).toBe(404);
    expect(previewRestore).toHaveBeenCalledTimes(1);

    const confirmed = await confirm(mutationHeaders, currentPreview.previewHandle);
    expect(confirmed.status).toBe(200);
    const confirmedText = await confirmed.text();
    const confirmedBody = JSON.parse(confirmedText) as {
      status: string;
      handoffId: string;
      expiresAt: string;
      executionBoundary: string;
      effects: { restoreExecution: boolean };
    };
    expect(confirmedBody).toEqual({
      status: 'pending',
      handoffId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    });
    expect(consumePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: sessionDigest,
      handle: currentPreview.previewHandle,
      actor: { kind: 'local_admin' },
      action: 'prepare_restore_handoff',
      resourceKind: 'operations_backup_restore',
      resourceId: backupRef,
      scope: { kind: 'system' },
    });
    expect(previewRestore).toHaveBeenCalledTimes(2);
    expect(previewRestore).toHaveBeenLastCalledWith(backupRef);
    const handoffDirectory = join(databaseDirectory, '.lethebot-governance-restore-handoff');
    const pendingPath = join(handoffDirectory, 'pending.json');
    expect(lstatSync(handoffDirectory).mode & 0o7777).toBe(0o700);
    expect(lstatSync(pendingPath).mode & 0o7777).toBe(0o600);
    const pendingText = readFileSync(pendingPath, 'utf8');
    const pendingEnvelope = JSON.parse(pendingText) as Record<string, unknown>;
    expect(pendingEnvelope).toEqual({
      schemaVersion: 1,
      state: 'pending',
      handoffId: confirmedBody.handoffId,
      backupRef,
      previewDigest: currentDigest,
      restoreContractVersion: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      expiresAt: confirmedBody.expiresAt,
      executionBoundary: 'stopped_service_only',
    });
    expect(readGovernanceRestoreHandoff({
      databasePath: join(databaseDirectory, 'lethebot.db'),
      now: new Date(),
    })).toEqual({
      status: 'pending',
      handoffId: confirmedBody.handoffId,
      expiresAt: confirmedBody.expiresAt,
      contractVersion: 1,
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    });
    expect(confirmedText).not.toContain(backupRef);
    expect(confirmedText).not.toContain(currentDigest);
    expect(confirmedText).not.toContain(databaseDirectory);
    expect(confirmedText).not.toContain('.lethebot-governance-backups');
    expect(confirmedText).not.toContain('.lethebot-governance-restore-handoff');
    expect(confirmedText).not.toContain('.db');
    expect(confirmedText).not.toContain(ADMIN_TOKEN);
    expect(confirmedText).not.toContain('diagnostic');

    const repeated = await confirm(mutationHeaders, currentPreview.previewHandle);
    expect(repeated.status).toBe(409);
    expect(await repeated.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(previewRestore).toHaveBeenCalledTimes(2);

    const stalePreview = await issueRestorePreview();
    currentDigest = '2'.repeat(64);
    const stale = await confirm(mutationHeaders, stalePreview.previewHandle);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toBe(JSON.stringify({ error: 'conflict' }));
    const consumedStale = await confirm(mutationHeaders, stalePreview.previewHandle);
    expect(consumedStale.status).toBe(409);
    expect(previewRestore).toHaveBeenCalledTimes(4);
    expect(readFileSync(pendingPath, 'utf8')).toBe(pendingText);

    const attentionPreview = await issueRestorePreview();
    const attention = await confirm(mutationHeaders, attentionPreview.previewHandle);
    expect(attention.status).toBe(200);
    expect(await attention.json()).toEqual({
      status: 'attention_required',
      handoffId: null,
      expiresAt: null,
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    });
    expect(previewRestore).toHaveBeenCalledTimes(6);
    const repeatedAttention = await confirm(mutationHeaders, attentionPreview.previewHandle);
    expect(repeatedAttention.status).toBe(409);
    expect(readFileSync(pendingPath, 'utf8')).toBe(pendingText);

    expect(createManagedBackup).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
    expect(readdirSync(databaseDirectory).sort()).toEqual([
      ...filesBefore,
      '.lethebot-governance-restore-handoff',
    ].sort());
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditsBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues purpose-isolated Privacy scope handles only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '934567890';
    const canonicalUserId = `privacy-http-user-${platformId}`;
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listPrivacyPreferenceScopeHandles',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-11T00:00:00.000Z');
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(canonicalUserId, now, now);

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/privacy/scopes`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?purpose=memory`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const catalog = JSON.parse(responseText) as {
      entries: Array<{
        fingerprint: string;
        scopeKind: string;
        label: string;
        handle: string;
        expiresAt: number;
      }>;
      truncated: boolean;
    };
    expect(catalog).toEqual({
      entries: [{
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        scopeKind: 'user',
        label: 'User privacy',
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: expect.any(Number),
      }],
      truncated: false,
    });
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(catalogRead).toHaveBeenCalledWith(expect.any(Function));
    expect(issueScopeHandle).toHaveBeenCalledTimes(1);
    expect(issueScopeHandle).toHaveBeenCalledWith({
      sessionId: sessionDigest,
      sessionExpiresAt: expect.any(Number),
      purpose: 'governance.privacy.preferences.read',
      scope: { kind: 'user', canonicalUserId },
    });
    expect(responseText).not.toContain(canonicalUserId);
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(sessionDigest);

    const legacyCatalog = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(legacyCatalog.status).toBe(200);
    expect(await legacyCatalog.json()).toEqual({ entries: [], truncated: false });

    const privacyHandle = catalog.entries[0]?.handle ?? '';
    const crossPurpose = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(crossPurpose.status).toBe(404);

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(catalogRead).toHaveBeenCalledTimes(2);
    expect(issueScopeHandle).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues display-profile scope handles only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '956789012';
    const secret = 'sk-displayprofilehttpabcdefghijklmnopqrstuvwxyz1234';
    const profileUserId = `display-profile-http-a-${platformId}`;
    const historyUserId = `display-profile-http-b-${platformId}`;
    const profileName = `Profile ${platformId} password=${secret}`;
    const historyName = `History ${platformId} password=${secret}`;
    const profileGroupId = `profile-group-${platformId}`;
    const historyGroupId = `history-group-${platformId}`;
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileScopeHandles',
    );
    const targetRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileTargetsForScope',
    );
    const targetResourceRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileTargetResourceHandlePage',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const issueResourceHandle = vi.spyOn(GovernanceResourceHandleRegistry.prototype, 'issue');
    const redactProfile = vi.spyOn(
      GovernanceService.prototype,
      'redactDisplayProfileAsLocalAdmin',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-19T00:00:00.000Z');
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(profileUserId, now, now);
    insertUser.run(historyUserId, now + 1, now + 1);
    db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, 'platform_provided')`,
    ).run(profileUserId, profileGroupId, profileName, now);
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    insertHistory.run(
      'display-profile-http-history',
      historyUserId,
      historyGroupId,
      historyName,
      now + 1,
    );
    insertHistory.run(
      'display-profile-http-duplicate',
      profileUserId,
      profileGroupId,
      profileName,
      now + 2,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/display-profile/scopes`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(catalogRead).not.toHaveBeenCalled();
    expect(targetRead).not.toHaveBeenCalled();
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(unauthenticated.status).toBe(401);

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?user=${profileUserId}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const catalog = JSON.parse(responseText) as {
      entries: Array<{
        fingerprint: string;
        scopeKind: string;
        label: string;
        handle: string;
        expiresAt: number;
      }>;
      truncated: boolean;
    };
    expect(catalog).toEqual({
      entries: [{
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        scopeKind: 'user',
        label: 'User display data',
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: expect.any(Number),
      }, {
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        scopeKind: 'user',
        label: 'User display data',
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: expect.any(Number),
      }],
      truncated: false,
    });
    catalog.entries.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
      ]);
    });
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(catalogRead).toHaveBeenCalledWith(expect.any(Function));
    const expectedScopes = [
      { kind: 'user' as const, canonicalUserId: profileUserId },
      { kind: 'user' as const, canonicalUserId: historyUserId },
    ];
    expect(issueScopeHandle.mock.calls.map(([input]) => input)).toEqual(
      expectedScopes.map((scope) => ({
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.display_profile.targets.read',
        scope,
      })),
    );
    const registry = issueScopeHandle.mock.contexts[0] as GovernanceScopeHandleRegistry;
    catalog.entries.forEach((entry, index) => {
      expect(registry.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.display_profile.targets.read',
      })).toEqual(expectedScopes[index]);
      expect(registry.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.privacy.preferences.read',
      })).toBeNull();
    });

    const otherSession = await loginGovernance(origin);
    const otherSessionDigest = digestSessionCookie(otherSession.cookie);
    catalog.entries.forEach((entry) => {
      expect(registry.resolve({
        sessionId: otherSessionDigest,
        handle: entry.handle,
        purpose: 'governance.display_profile.targets.read',
      })).toBeNull();
    });

    for (const rawValue of [
      profileUserId,
      historyUserId,
      platformId,
      profileName,
      historyName,
      profileGroupId,
      historyGroupId,
      sessionDigest,
      secret,
    ]) {
      expect(responseText).not.toContain(rawValue);
    }

    const targetPath = `${API_PREFIX}/display-profile/targets`;
    const malformedPreview = await fetch(`${origin}${targetPath}/target-handle`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': session.csrfToken,
        'X-LetheBot-Scope': catalog.entries[0]?.handle ?? '',
      },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(malformedPreview.status).toBe(400);
    expect(targetRead).not.toHaveBeenCalled();
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(catalogRead).toHaveBeenCalledTimes(2);
    expect(issueScopeHandle).toHaveBeenCalledTimes(4);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves display-profile target resource handles only through current user-scope authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '946789012';
    const secret = 'sk-displaytargethttpabcdefghijklmnopqrstuvwxyz1234';
    const canonicalUserId = `display-target-http-user-${platformId}-${secret}`;
    const otherUserId = `display-target-http-other-${platformId}-${secret}`;
    const groupId = `display-target-http-group-${platformId}-${secret}`;
    const privateProfileName = `Private profile ${platformId} password=${secret}`;
    const groupProfileName = `Group profile ${platformId} password=${secret}`;
    const groupHistoryName = `Group history ${platformId} password=${secret}`;
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileScopeHandles',
    );
    const targetResourceRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileTargetResourceHandlePage',
    );
    const legacyTargetRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileTargetsForScope',
    );
    const resolveScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'resolve',
    );
    const issueScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'issue',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const redactProfile = vi.spyOn(
      GovernanceService.prototype,
      'redactDisplayProfileAsLocalAdmin',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-20T00:00:00.000Z');
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(canonicalUserId, now, now);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertProfile.run(canonicalUserId, '', privateProfileName, now, 'user_set');
    insertProfile.run(
      canonicalUserId,
      groupId,
      groupProfileName,
      now + 100,
      'platform_provided',
    );
    db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      'display-target-http-group-history',
      canonicalUserId,
      groupId,
      groupHistoryName,
      now + 200,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/display-profile/targets`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(legacyTargetRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const scopeCatalogResponse = await fetch(
      `${origin}${API_PREFIX}/display-profile/scopes`,
      { headers: { Connection: 'close', Cookie: firstSession.cookie } },
    );
    expect(scopeCatalogResponse.status).toBe(200);
    const scopeCatalog = await scopeCatalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
      truncated: boolean;
    };
    expect(scopeCatalog.entries).toHaveLength(1);
    const scopeEntry = scopeCatalog.entries[0];
    const scopeHandle = scopeEntry?.handle ?? '';
    const sessionExpiresAt = scopeEntry?.expiresAt ?? 0;
    expect(scopeHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(catalogRead).toHaveBeenCalledTimes(1);
    const scope = { kind: 'user', canonicalUserId } as const;
    expect(issueScopeHandle).toHaveBeenCalledTimes(1);
    expect(issueScopeHandle).toHaveBeenCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope,
    });
    const scopeRegistry = issueScopeHandle.mock.contexts[0] as
      GovernanceScopeHandleRegistry;
    expect(scopeRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: scopeHandle,
      purpose: 'governance.display_profile.targets.read',
    })).toEqual(scope);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();

    const missingScope = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingScope.status).toBe(400);
    expect(await missingScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const malformedScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedScope.status).toBe(400);
    expect(await malformedScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const withQuery = await fetch(`${origin}${path}?include=raw`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(withQuery.status).toBe(400);
    expect(await withQuery.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownScope.status).toBe(404);
    expect(await unknownScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const secondSessionDigest = digestSessionCookie(secondSession.cookie);
    const crossSessionScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(crossSessionScope.status).toBe(404);
    expect(await crossSessionScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const crossPurposeScopeHandle = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.memory.records.read',
      scope,
    }).handle;
    const crossPurposeScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': crossPurposeScopeHandle,
      },
    });
    expect(crossPurposeScope.status).toBe(404);
    expect(await crossPurposeScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const targetFingerprint = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex')
      .slice(0, 16);
    const targetResourceId = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex');
    const sourceGroupIds = ['', groupId] as const;
    const expectedTargetIds = sourceGroupIds.map(targetResourceId);
    const response = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const responseBody = JSON.parse(responseText) as {
      entries: Array<{ handle: string; handleExpiresAt: number }>;
      truncated: boolean;
    };
    expect(responseBody).toEqual({
      entries: [{
        fingerprint: targetFingerprint(''),
        targetKind: 'private_or_global',
        label: 'Private/global display data',
        currentProfile: {
          present: true,
          trust: 'user_set',
          observedAt: new Date(now).toISOString(),
        },
        history: {
          count: 0,
          truncated: false,
          lifecycle: 'absent',
          latestObservedAt: null,
        },
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        handleExpiresAt: sessionExpiresAt,
      }, {
        fingerprint: targetFingerprint(groupId),
        targetKind: 'group',
        label: 'Group display data',
        currentProfile: {
          present: true,
          trust: 'platform_provided',
          observedAt: new Date(now + 100).toISOString(),
        },
        history: {
          count: 1,
          truncated: false,
          lifecycle: 'open',
          latestObservedAt: new Date(now + 200).toISOString(),
        },
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        handleExpiresAt: sessionExpiresAt,
      }],
      truncated: false,
    });
    expect(targetResourceRead).toHaveBeenCalledTimes(1);
    expect(targetResourceRead).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(legacyTargetRead).not.toHaveBeenCalled();
    expect(issueResourceHandle.mock.calls.map(([input]) => input)).toEqual(
      expectedTargetIds.map((resourceId) => ({
        sessionId: firstSessionDigest,
        sessionExpiresAt,
        purpose: 'governance.display_profile.targets.read',
        resourceKind: 'display_profile_target',
        resourceId,
        scope,
      })),
    );

    const resourceRegistry = issueResourceHandle.mock.contexts[0] as
      GovernanceResourceHandleRegistry;
    responseBody.entries.forEach((entry, index) => {
      expect(resourceRegistry.resolve({
        sessionId: firstSessionDigest,
        handle: entry.handle,
        purpose: 'governance.display_profile.targets.read',
        resourceKind: 'display_profile_target',
        scope,
      })).toEqual({
        kind: 'display_profile_target',
        resourceId: expectedTargetIds[index],
      });
    });
    const firstResourceHandle = responseBody.entries[0]?.handle ?? '';
    expect(resourceRegistry.resolve({
      sessionId: secondSessionDigest,
      handle: firstResourceHandle,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'display_profile_target',
      scope,
    })).toBeNull();
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: firstResourceHandle,
      purpose: 'governance.privacy.preferences.read',
      resourceKind: 'display_profile_target',
      scope,
    })).toBeNull();
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: firstResourceHandle,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'memory_record',
      scope,
    })).toBeNull();
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: firstResourceHandle,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'display_profile_target',
      scope: { kind: 'user', canonicalUserId: otherUserId },
    })).toBeNull();

    for (const rawValue of [
      canonicalUserId,
      otherUserId,
      groupId,
      platformId,
      secret,
      privateProfileName,
      groupProfileName,
      groupHistoryName,
      firstSessionDigest,
      firstSession.cookie.slice(`${SESSION_COOKIE}=`.length),
      ...expectedTargetIds,
    ]) {
      expect(responseText).not.toContain(rawValue);
    }

    const resourceResolutionCount = resolveResourceHandle.mock.calls.length;
    const dynamicPath = `${path}/${firstResourceHandle}`;
    const unknownConfirmation = await fetch(`${origin}${dynamicPath}/confirm`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': scopeHandle,
      },
      body: JSON.stringify({ confirm: true, previewHandle: 'p'.repeat(43) }),
    });
    expect(unknownConfirmation.status).toBe(404);
    const absentListMutation = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': scopeHandle,
      },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(absentListMutation.status).toBe(404);
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 1);
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();

    const repeated = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(targetResourceRead).toHaveBeenCalledTimes(2);
    expect(issueResourceHandle).toHaveBeenCalledTimes(4);
    expect(legacyTargetRead).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves display-profile target detail only through exact current target-resource authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '957890123';
    const secret = 'sk-displaytargetdetailhttpabcdefghijklmnopqrstuvwxyz12';
    const canonicalUserId = `display-target-detail-http-user-${platformId}-${secret}`;
    const otherUserId = `display-target-detail-http-other-${platformId}-${secret}`;
    const groupId = `display-target-detail-http-group-${platformId}-${secret}`;
    const groupHistoryId = `display-target-detail-http-history-${platformId}-${secret}`;
    const privateDisplayName = 'Private target detail value';
    const groupDisplayName = `Group target detail ${platformId} password=${secret} ${
      '\u{1F642}'.repeat(180)
    }`;
    const groupHistoryName = 'Prior group target detail value';
    const scopeCatalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileScopeHandles',
    );
    const targetResourceRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileTargetResourceHandlePage',
    );
    const targetDetailRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getDisplayProfileTargetDetailForScope',
    );
    const legacyTargetRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listDisplayProfileTargetsForScope',
    );
    const resolveScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'resolve',
    );
    const issueScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const redactProfile = vi.spyOn(
      GovernanceService.prototype,
      'redactDisplayProfileAsLocalAdmin',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-21T00:00:00.000Z');
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(canonicalUserId, now, now);
    insertUser.run(otherUserId, now, now);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertProfile.run(canonicalUserId, '', privateDisplayName, now, 'user_set');
    insertProfile.run(
      canonicalUserId,
      groupId,
      groupDisplayName,
      now + 100,
      'platform_provided',
    );
    db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      groupHistoryId,
      canonicalUserId,
      groupId,
      groupHistoryName,
      now + 200,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/display-profile/targets`;
    const unauthenticated = await fetch(`${origin}${path}/${'r'.repeat(43)}`, {
      headers: {
        Connection: 'close',
        'X-LetheBot-Scope': 's'.repeat(43),
      },
    });
    expect(scopeCatalogRead).not.toHaveBeenCalled();
    expect(targetResourceRead).not.toHaveBeenCalled();
    expect(targetDetailRead).not.toHaveBeenCalled();
    expect(legacyTargetRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const scopeCatalogResponse = await fetch(
      `${origin}${API_PREFIX}/display-profile/scopes`,
      { headers: { Connection: 'close', Cookie: firstSession.cookie } },
    );
    expect(scopeCatalogResponse.status).toBe(200);
    const scopeCatalog = await scopeCatalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
      truncated: boolean;
    };
    expect(scopeCatalog.entries).toHaveLength(1);
    const scopeHandle = scopeCatalog.entries[0]?.handle ?? '';
    const sessionExpiresAt = scopeCatalog.entries[0]?.expiresAt ?? 0;
    const scope = { kind: 'user', canonicalUserId } as const;
    expect(scopeCatalogRead).toHaveBeenCalledTimes(1);
    expect(issueScopeHandle).toHaveBeenCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope,
    });

    const targetPageResponse = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(targetPageResponse.status).toBe(200);
    const targetPageText = await targetPageResponse.text();
    const targetPage = JSON.parse(targetPageText) as {
      entries: Array<{
        fingerprint: string;
        targetKind: 'private_or_global' | 'group';
        label: string;
        currentProfile: {
          present: boolean;
          trust: string | null;
          observedAt: string | null;
        };
        history: {
          count: number;
          truncated: boolean;
          lifecycle: string;
          latestObservedAt: string | null;
        };
        handle: string;
        handleExpiresAt: number;
      }>;
      truncated: boolean;
    };
    expect(targetPage.entries).toHaveLength(2);
    expect(targetResourceRead).toHaveBeenCalledTimes(1);
    expect(targetResourceRead).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(legacyTargetRead).not.toHaveBeenCalled();
    const privateEntry = targetPage.entries.find(
      (entry) => entry.targetKind === 'private_or_global',
    );
    const groupEntry = targetPage.entries.find((entry) => entry.targetKind === 'group');
    expect(privateEntry?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(groupEntry?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const privateResourceHandle = privateEntry?.handle ?? '';
    const groupResourceHandle = groupEntry?.handle ?? '';
    const privateDetailPath = `${path}/${privateResourceHandle}`;
    const groupDetailPath = `${path}/${groupResourceHandle}`;
    const scopeRegistry = issueScopeHandle.mock.contexts[0] as
      GovernanceScopeHandleRegistry;
    const resourceRegistry = issueResourceHandle.mock.contexts[0] as
      GovernanceResourceHandleRegistry;
    const targetResourceId = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex');
    const privateTargetId = targetResourceId('');
    const groupTargetId = targetResourceId(groupId);
    expect(issueResourceHandle.mock.calls.slice(0, 2).map(([input]) => input)).toEqual([
      {
        sessionId: firstSessionDigest,
        sessionExpiresAt,
        purpose: 'governance.display_profile.targets.read',
        resourceKind: 'display_profile_target',
        resourceId: privateTargetId,
        scope,
      },
      {
        sessionId: firstSessionDigest,
        sessionExpiresAt,
        purpose: 'governance.display_profile.targets.read',
        resourceKind: 'display_profile_target',
        resourceId: groupTargetId,
        scope,
      },
    ]);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const resourceResolutionCount = resolveResourceHandle.mock.calls.length;

    const missingScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingScope.status).toBe(400);
    expect(await missingScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(targetDetailRead).not.toHaveBeenCalled();

    const malformedScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedScope.status).toBe(400);
    expect(await malformedScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(targetDetailRead).not.toHaveBeenCalled();

    for (const malformedPath of [`${path}/`, `${path}/malformed`]) {
      const malformedResource = await fetch(`${origin}${malformedPath}`, {
        headers: {
          Connection: 'close',
          Cookie: firstSession.cookie,
          'X-LetheBot-Scope': scopeHandle,
        },
      });
      expect(malformedResource.status).toBe(400);
      expect(await malformedResource.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(targetDetailRead).not.toHaveBeenCalled();

    const withQuery = await fetch(`${origin}${groupDetailPath}?include=raw`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(withQuery.status).toBe(400);
    expect(await withQuery.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(targetDetailRead).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownScope.status).toBe(404);
    expect(await unknownScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(targetDetailRead).not.toHaveBeenCalled();

    const crossPurposeScopeHandle = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.memory.records.read',
      scope,
    }).handle;
    const crossPurposeScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': crossPurposeScopeHandle,
      },
    });
    expect(crossPurposeScope.status).toBe(404);
    expect(await crossPurposeScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(targetDetailRead).not.toHaveBeenCalled();

    const unknownResource = await fetch(`${origin}${path}/${'y'.repeat(43)}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(unknownResource.status).toBe(404);
    expect(await unknownResource.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetDetailRead).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const secondSessionDigest = digestSessionCookie(secondSession.cookie);
    const secondSessionScopeHandle = scopeRegistry.issue({
      sessionId: secondSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope,
    }).handle;
    const crossSession = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': secondSessionScopeHandle,
      },
    });
    expect(crossSession.status).toBe(404);
    expect(await crossSession.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetDetailRead).not.toHaveBeenCalled();

    const crossPurposeResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.memory.records.read',
      resourceKind: 'display_profile_target',
      resourceId: groupTargetId,
      scope,
    });
    const crossPurpose = await fetch(`${origin}${path}/${crossPurposeResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(crossPurpose.status).toBe(404);
    expect(await crossPurpose.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetDetailRead).not.toHaveBeenCalled();

    const crossKindResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'memory_record',
      resourceId: groupTargetId,
      scope,
    });
    const crossKind = await fetch(`${origin}${path}/${crossKindResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(crossKind.status).toBe(404);
    expect(await crossKind.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetDetailRead).not.toHaveBeenCalled();

    const otherScope = { kind: 'user', canonicalUserId: otherUserId } as const;
    const otherScopeHandle = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope: otherScope,
    }).handle;
    const crossScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': otherScopeHandle,
      },
    });
    expect(crossScope.status).toBe(404);
    expect(await crossScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetDetailRead).not.toHaveBeenCalled();

    const missingTargetId = targetResourceId('missing-target-evidence');
    const missingTargetResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'display_profile_target',
      resourceId: missingTargetId,
      scope,
    });
    const missingDetail = await fetch(`${origin}${path}/${missingTargetResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(missingDetail.status).toBe(404);
    expect(await missingDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(targetDetailRead).toHaveBeenCalledTimes(1);
    expect(targetDetailRead).toHaveBeenLastCalledWith({
      scope,
      targetId: missingTargetId,
    });

    const privateDetail = await fetch(`${origin}${privateDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(privateDetail.status).toBe(200);
    const privateDetailText = await privateDetail.text();
    const {
      handle: _privateHandle,
      handleExpiresAt: _privateHandleExpiresAt,
      ...privateTarget
    } = privateEntry ?? {};
    expect(JSON.parse(privateDetailText)).toEqual({
      target: privateTarget,
      currentDisplay: {
        value: privateDisplayName,
        redacted: false,
        truncated: false,
      },
      nicknameHistory: [],
      nicknameHistoryTruncated: false,
    });
    expect(targetDetailRead).toHaveBeenCalledTimes(2);
    expect(targetDetailRead).toHaveBeenLastCalledWith({
      scope,
      targetId: privateTargetId,
    });

    const groupDetail = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(groupDetail.status).toBe(200);
    const groupDetailText = await groupDetail.text();
    const groupDetailBody = JSON.parse(groupDetailText) as {
      target: unknown;
      currentDisplay: { value: string; redacted: boolean; truncated: boolean };
      nicknameHistory: Array<{
        fingerprint: string;
        value: string;
        redacted: boolean;
        truncated: boolean;
        observedAt: string;
        observedUntil: string | null;
      }>;
      nicknameHistoryTruncated: boolean;
    };
    const {
      handle: _groupHandle,
      handleExpiresAt: _groupHandleExpiresAt,
      ...groupTarget
    } = groupEntry ?? {};
    expect(groupDetailBody.target).toEqual(groupTarget);
    expect(groupDetailBody.currentDisplay).toMatchObject({
      redacted: true,
      truncated: true,
    });
    expect(Array.from(groupDetailBody.currentDisplay.value)).toHaveLength(160);
    expect(groupDetailBody.nicknameHistory).toEqual([{
      fingerprint: createHash('sha256')
        .update('lethebot-governance:display-profile-nickname-history:v1\0', 'utf8')
        .update(groupHistoryId, 'utf8')
        .digest('hex')
        .slice(0, 16),
      value: groupHistoryName,
      redacted: false,
      truncated: false,
      observedAt: new Date(now + 200).toISOString(),
      observedUntil: null,
    }]);
    expect(groupDetailBody.nicknameHistoryTruncated).toBe(false);
    expect(targetDetailRead).toHaveBeenCalledTimes(3);
    expect(targetDetailRead).toHaveBeenLastCalledWith({ scope, targetId: groupTargetId });

    const repeatedDetail = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(repeatedDetail.status).toBe(200);
    expect(await repeatedDetail.text()).toBe(groupDetailText);
    expect(targetDetailRead).toHaveBeenCalledTimes(4);

    const repeatedPage = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(repeatedPage.status).toBe(200);
    expect(await repeatedPage.text()).toBe(targetPageText);
    expect(targetResourceRead).toHaveBeenCalledTimes(2);
    expect(legacyTargetRead).not.toHaveBeenCalled();

    for (const detailText of [privateDetailText, groupDetailText]) {
      for (const rawValue of [
        canonicalUserId,
        otherUserId,
        platformId,
        secret,
        groupId,
        groupHistoryId,
        firstSessionDigest,
        secondSessionDigest,
        privateTargetId,
        groupTargetId,
        missingTargetId,
        privateResourceHandle,
        groupResourceHandle,
      ]) {
        expect(detailText).not.toContain(rawValue);
      }
    }

    const confirmation = await fetch(`${origin}${groupDetailPath}/confirm`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': scopeHandle,
      },
      body: JSON.stringify({ confirm: true, previewHandle: 'p'.repeat(43) }),
    });
    expect(confirmation.status).toBe(404);
    const listMutation = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': scopeHandle,
      },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(listMutation.status).toBe(404);
    expect(targetDetailRead).toHaveBeenCalledTimes(4);
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues display-profile redaction preview authority without mutation', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '968901234';
    const secret = 'sk-displayprofilepreviewabcdefghijklmnopqrstuvwxyz12';
    const canonicalUserId = `display-profile-preview-user-${platformId}-${secret}`;
    const otherUserId = `display-profile-preview-other-${platformId}-${secret}`;
    const groupId = `display-profile-preview-group-${platformId}-${secret}`;
    const historyId = `display-profile-preview-history-${platformId}-${secret}`;
    const previewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getDisplayProfileTargetRedactionPreviewForScope',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const resolveScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'resolve',
    );
    const issueScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const redactProfile = vi.spyOn(
      GovernanceService.prototype,
      'redactDisplayProfileAsLocalAdmin',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-22T00:00:00.000Z');
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(canonicalUserId, now, now);
    insertUser.run(otherUserId, now, now);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertProfile.run(canonicalUserId, '', 'Private preview value', now, 'user_set');
    insertProfile.run(
      canonicalUserId,
      groupId,
      `Group preview ${platformId} password=${secret}`,
      now + 100,
      'platform_provided',
    );
    db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      historyId,
      canonicalUserId,
      groupId,
      `Prior preview ${platformId} token=${secret}`,
      now + 200,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/display-profile/targets`;
    const unauthenticated = await fetch(`${origin}${path}/${'r'.repeat(43)}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-Scope': 's'.repeat(43),
      },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(previewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const scopeCatalogResponse = await fetch(
      `${origin}${API_PREFIX}/display-profile/scopes`,
      { headers: { Connection: 'close', Cookie: firstSession.cookie } },
    );
    expect(scopeCatalogResponse.status).toBe(200);
    const scopeCatalog = await scopeCatalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
      truncated: boolean;
    };
    expect(scopeCatalog.entries).toHaveLength(1);
    const scopeHandle = scopeCatalog.entries[0]?.handle ?? '';
    const sessionExpiresAt = scopeCatalog.entries[0]?.expiresAt ?? 0;
    const scope = { kind: 'user', canonicalUserId } as const;
    expect(issueScopeHandle).toHaveBeenCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope,
    });

    const targetPageResponse = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(targetPageResponse.status).toBe(200);
    const targetPage = await targetPageResponse.json() as {
      entries: Array<{
        targetKind: 'private_or_global' | 'group';
        handle: string;
      }>;
      truncated: boolean;
    };
    expect(targetPage.entries).toHaveLength(2);
    const privateResourceHandle = targetPage.entries.find(
      (entry) => entry.targetKind === 'private_or_global',
    )?.handle ?? '';
    const groupResourceHandle = targetPage.entries.find(
      (entry) => entry.targetKind === 'group',
    )?.handle ?? '';
    const privateDetailPath = `${path}/${privateResourceHandle}`;
    const groupDetailPath = `${path}/${groupResourceHandle}`;
    const targetResourceId = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex');
    const privateTargetId = targetResourceId('');
    const groupTargetId = targetResourceId(groupId);
    const scopeRegistry = issueScopeHandle.mock.contexts[0] as
      GovernanceScopeHandleRegistry;
    const resourceRegistry = issueResourceHandle.mock.contexts[0] as
      GovernanceResourceHandleRegistry;
    const mutationHeaders = {
      Connection: 'close',
      Cookie: firstSession.cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': firstSession.csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    };
    const changesBeforePreviews = db.prepare('SELECT total_changes()').pluck().get();
    const scopeResolutionCount = resolveScopeHandle.mock.calls.length;
    const resourceResolutionCount = resolveResourceHandle.mock.calls.length;

    const missingCsrf = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-CSRF': '' },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(missingCsrf.status).toBe(403);
    const wrongOrigin = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, Origin: 'http://127.0.0.1:1' },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(resolveScopeHandle).toHaveBeenCalledTimes(scopeResolutionCount);
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(previewRead).not.toHaveBeenCalled();

    const missingScope = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-Scope': '' },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(missingScope.status).toBe(400);
    const malformedResource = await fetch(`${origin}${path}/malformed`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(malformedResource.status).toBe(400);
    const queried = await fetch(`${origin}${groupDetailPath}?confirm=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(queried.status).toBe(400);
    expect(previewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-Scope': 'z'.repeat(43) },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(unknownScope.status).toBe(404);
    const unknownResource = await fetch(`${origin}${path}/${'y'.repeat(43)}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(unknownResource.status).toBe(404);
    expect(previewRead).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const secondSessionDigest = digestSessionCookie(secondSession.cookie);
    const secondSessionScopeHandle = scopeRegistry.issue({
      sessionId: secondSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope,
    }).handle;
    const crossSession = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        Cookie: secondSession.cookie,
        'X-LetheBot-CSRF': secondSession.csrfToken,
        'X-LetheBot-Scope': secondSessionScopeHandle,
      },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(crossSession.status).toBe(404);

    const crossPurposeScopeHandle = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.memory.records.read',
      scope,
    }).handle;
    const crossPurposeScope = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-Scope': crossPurposeScopeHandle },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(crossPurposeScope.status).toBe(404);

    const crossPurposeResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.memory.records.read',
      resourceKind: 'display_profile_target',
      resourceId: groupTargetId,
      scope,
    });
    const crossPurpose = await fetch(`${origin}${path}/${crossPurposeResource.handle}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(crossPurpose.status).toBe(404);

    const crossKindResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'memory_record',
      resourceId: groupTargetId,
      scope,
    });
    const crossKind = await fetch(`${origin}${path}/${crossKindResource.handle}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(crossKind.status).toBe(404);

    const otherScope = { kind: 'user', canonicalUserId: otherUserId } as const;
    const otherScopeHandle = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      scope: otherScope,
    }).handle;
    const crossScope = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-Scope': otherScopeHandle },
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(crossScope.status).toBe(404);
    expect(previewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    for (const body of [
      null,
      [],
      {},
      { action: 'delete' },
      { action: 'redact', targetId: groupTargetId },
    ]) {
      const invalidBody = await fetch(`${origin}${groupDetailPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBody.status).toBe(400);
      expect(await invalidBody.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(previewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    const missingTargetId = targetResourceId('missing-preview-target');
    const missingTargetResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'display_profile_target',
      resourceId: missingTargetId,
      scope,
    });
    const missingPreview = await fetch(`${origin}${path}/${missingTargetResource.handle}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(missingPreview.status).toBe(404);
    expect(await missingPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(previewRead).toHaveBeenCalledTimes(1);
    expect(previewRead).toHaveBeenLastCalledWith({ scope, targetId: missingTargetId });
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    const privatePreviewResponse = await fetch(`${origin}${privateDetailPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(privatePreviewResponse.status).toBe(201);
    const privatePreviewText = await privatePreviewResponse.text();
    const privatePreview = JSON.parse(privatePreviewText) as
      DisplayProfileTargetRedactionPreviewProjection & {
        previewHandle: string;
        previewExpiresAt: number;
      };
    const privateProjection = await previewRead.mock.results[1]?.value as
      DisplayProfileTargetRedactionPreviewProjection | null;
    expect(privateProjection).not.toBeNull();
    const {
      previewHandle: privatePreviewHandle,
      previewExpiresAt: privatePreviewExpiresAt,
      ...privateResponseProjection
    } = privatePreview;
    expect(privateResponseProjection).toEqual(JSON.parse(JSON.stringify(privateProjection)));
    expect(privatePreviewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(privatePreviewExpiresAt).toBe(sessionExpiresAt);
    expect(previewRead).toHaveBeenLastCalledWith({ scope, targetId: privateTargetId });
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      actor: { kind: 'local_admin' },
      action: 'display_profile.redact',
      resourceKind: 'display_profile_target',
      resourceId: privateTargetId,
      scope,
      expectedState: privateProjection?.current.snapshotFingerprint,
      expectedRevisionNumber: privateProjection?.expected.affectedRows.total,
      previewDigest: privateProjection?.previewDigest,
    });

    const groupPreviewResponse = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(groupPreviewResponse.status).toBe(201);
    const groupPreviewText = await groupPreviewResponse.text();
    const groupPreview = JSON.parse(groupPreviewText) as
      DisplayProfileTargetRedactionPreviewProjection & {
        previewHandle: string;
        previewExpiresAt: number;
      };
    const groupProjection = await previewRead.mock.results[2]?.value as
      DisplayProfileTargetRedactionPreviewProjection | null;
    expect(groupProjection).not.toBeNull();
    const {
      previewHandle: groupPreviewHandle,
      previewExpiresAt: groupPreviewExpiresAt,
      ...groupResponseProjection
    } = groupPreview;
    expect(groupResponseProjection).toEqual(JSON.parse(JSON.stringify(groupProjection)));
    expect(groupPreviewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(groupPreviewHandle).not.toBe(privatePreviewHandle);
    expect(groupPreviewExpiresAt).toBe(sessionExpiresAt);
    expect(previewRead).toHaveBeenLastCalledWith({ scope, targetId: groupTargetId });
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt,
      actor: { kind: 'local_admin' },
      action: 'display_profile.redact',
      resourceKind: 'display_profile_target',
      resourceId: groupTargetId,
      scope,
      expectedState: groupProjection?.current.snapshotFingerprint,
      expectedRevisionNumber: groupProjection?.expected.affectedRows.total,
      previewDigest: groupProjection?.previewDigest,
    });

    const repeatedPreviewResponse = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(repeatedPreviewResponse.status).toBe(201);
    const repeatedPreview = await repeatedPreviewResponse.json() as
      DisplayProfileTargetRedactionPreviewProjection & {
        previewHandle: string;
        previewExpiresAt: number;
      };
    const repeatedProjection = await previewRead.mock.results[3]?.value as
      DisplayProfileTargetRedactionPreviewProjection | null;
    const {
      previewHandle: repeatedPreviewHandle,
      previewExpiresAt: _repeatedPreviewExpiresAt,
      ...repeatedResponseProjection
    } = repeatedPreview;
    expect(repeatedResponseProjection).toEqual(JSON.parse(JSON.stringify(repeatedProjection)));
    expect(repeatedPreviewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(repeatedPreviewHandle).not.toBe(groupPreviewHandle);
    expect(repeatedProjection).toEqual(groupProjection);
    expect(previewRead).toHaveBeenCalledTimes(4);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(3);

    for (const responseText of [privatePreviewText, groupPreviewText]) {
      for (const rawValue of [
        canonicalUserId,
        otherUserId,
        platformId,
        secret,
        groupId,
        historyId,
        firstSessionDigest,
        secondSessionDigest,
        privateTargetId,
        groupTargetId,
        missingTargetId,
        privateResourceHandle,
        groupResourceHandle,
      ]) {
        expect(responseText).not.toContain(rawValue);
      }
    }

    const listMutation = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'redact' }),
    });
    expect(listMutation.status).toBe(404);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforePreviews);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(0);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('confirms display-profile redaction once through exact preview authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '979012345';
    const secret = 'sk-displayprofileconfirmabcdefghijklmnopqrstuvwxyz12';
    const canonicalUserId = `display-profile-confirm-user-${platformId}-${secret}`;
    const groupId = `display-profile-confirm-group-${platformId}-${secret}`;
    const historyId = `display-profile-confirm-history-${platformId}-${secret}`;
    const privateDisplay = 'Private confirmation display';
    const groupDisplay = `Group confirmation ${platformId} password=${secret}`;
    const historyDisplay = `History confirmation ${platformId} token=${secret}`;
    const previewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getDisplayProfileTargetRedactionPreviewForScope',
    );
    const resolveMutation = vi.spyOn(
      GovernanceQueryService.prototype,
      'resolveDisplayProfileTargetRedactionMutationForScope',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const redactProfile = vi.spyOn(
      GovernanceService.prototype,
      'redactDisplayProfileAsLocalAdmin',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-23T00:00:00.000Z');
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(canonicalUserId, now, now);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertProfile.run(canonicalUserId, '', privateDisplay, now, 'user_set');
    insertProfile.run(
      canonicalUserId,
      groupId,
      groupDisplay,
      now + 100,
      'platform_provided',
    );
    db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(historyId, canonicalUserId, groupId, historyDisplay, now + 200);

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/display-profile/targets`;
    const unauthenticated = await fetch(`${origin}${path}/${'r'.repeat(43)}/confirm`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-Scope': 's'.repeat(43),
      },
      body: JSON.stringify({ confirm: true, previewHandle: 'p'.repeat(43) }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(previewRead).not.toHaveBeenCalled();
    expect(resolveMutation).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const scopeCatalogResponse = await fetch(
      `${origin}${API_PREFIX}/display-profile/scopes`,
      { headers: { Connection: 'close', Cookie: session.cookie } },
    );
    expect(scopeCatalogResponse.status).toBe(200);
    const scopeCatalog = await scopeCatalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
    };
    const scopeHandle = scopeCatalog.entries[0]?.handle ?? '';
    const sessionExpiresAt = scopeCatalog.entries[0]?.expiresAt ?? 0;
    const scope = { kind: 'user', canonicalUserId } as const;
    const targetPageResponse = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': scopeHandle,
      },
    });
    expect(targetPageResponse.status).toBe(200);
    const targetPage = await targetPageResponse.json() as {
      entries: Array<{
        targetKind: 'private_or_global' | 'group';
        handle: string;
      }>;
    };
    const privateResourceHandle = targetPage.entries.find(
      (entry) => entry.targetKind === 'private_or_global',
    )?.handle ?? '';
    const groupResourceHandle = targetPage.entries.find(
      (entry) => entry.targetKind === 'group',
    )?.handle ?? '';
    const privateDetailPath = `${path}/${privateResourceHandle}`;
    const groupDetailPath = `${path}/${groupResourceHandle}`;
    const groupConfirmPath = `${groupDetailPath}/confirm`;
    const privateConfirmPath = `${privateDetailPath}/confirm`;
    const targetIdFor = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex');
    const privateTargetId = targetIdFor('');
    const groupTargetId = targetIdFor(groupId);
    expect(issueResourceHandle.mock.calls.slice(0, 2).map(([input]) => input.resourceId))
      .toEqual([privateTargetId, groupTargetId]);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': session.csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    };
    const createPreview = async (detailPath: string): Promise<{
      previewHandle: string;
      previewDigest: string;
      current: {
        displayProfileRows: number;
        nicknameHistoryRows: number;
        openNicknameHistoryRows: number;
        snapshotFingerprint: string;
      };
      expected: {
        affectedRows: { displayProfiles: number; nicknameHistory: number; total: number };
        durableEffects: string[];
        privacyConsequences: string[];
      };
      rollback: { supported: false; boundary: string };
      target: unknown;
    }> => {
      const response = await fetch(`${origin}${detailPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ action: 'redact' }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{
        previewHandle: string;
        previewDigest: string;
        current: {
          displayProfileRows: number;
          nicknameHistoryRows: number;
          openNicknameHistoryRows: number;
          snapshotFingerprint: string;
        };
        expected: {
          affectedRows: { displayProfiles: number; nicknameHistory: number; total: number };
          durableEffects: string[];
          privacyConsequences: string[];
        };
        rollback: { supported: false; boundary: string };
        target: unknown;
      }>;
    };

    const firstGroupPreview = await createPreview(groupDetailPath);
    expect(firstGroupPreview.previewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const confirmationBody = (previewHandle: string): string => JSON.stringify({
      confirm: true,
      previewHandle,
    });
    const consumptionCountBeforeBoundary = consumePreviewHandle.mock.calls.length;
    const missingCsrf = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-CSRF': '' },
      body: confirmationBody(firstGroupPreview.previewHandle),
    });
    expect(missingCsrf.status).toBe(403);
    const wrongOrigin = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, Origin: 'http://127.0.0.1:1' },
      body: confirmationBody(firstGroupPreview.previewHandle),
    });
    expect(wrongOrigin.status).toBe(403);
    const queried = await fetch(`${origin}${groupConfirmPath}?force=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(firstGroupPreview.previewHandle),
    });
    expect(queried.status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { confirm: false, previewHandle: firstGroupPreview.previewHandle },
      { confirm: true, previewHandle: 'malformed' },
      { confirm: true, previewHandle: firstGroupPreview.previewHandle, reason: 'caller' },
    ]) {
      const invalid = await fetch(`${origin}${groupConfirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
    }
    expect(consumePreviewHandle).toHaveBeenCalledTimes(consumptionCountBeforeBoundary);
    expect(resolveMutation).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();

    const unknownAuthority = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody('z'.repeat(43)),
    });
    expect(unknownAuthority.status).toBe(404);
    expect(await unknownAuthority.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const previewRegistry = issuePreviewHandle.mock.contexts[0] as
      GovernancePreviewHandleRegistry;
    const crossActionAuthority = previewRegistry.issue({
      sessionId: sessionDigest,
      sessionExpiresAt,
      actor: { kind: 'local_admin' },
      action: 'memory.record.forget',
      resourceKind: 'display_profile_target',
      resourceId: groupTargetId,
      scope,
      expectedState: firstGroupPreview.current.snapshotFingerprint,
      expectedRevisionNumber: firstGroupPreview.expected.affectedRows.total,
      previewDigest: firstGroupPreview.previewDigest,
    });
    const crossAction = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(crossActionAuthority.handle),
    });
    expect(crossAction.status).toBe(404);
    expect(resolveMutation).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();

    db.prepare(
      `UPDATE display_profiles SET current_display_name = ?
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).run('Drifted confirmation display', canonicalUserId, groupId);
    const previewReadsBeforeDrift = previewRead.mock.calls.length;
    const staleConfirmation = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(firstGroupPreview.previewHandle),
    });
    expect(staleConfirmation.status).toBe(409);
    expect(await staleConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(previewRead).toHaveBeenCalledTimes(previewReadsBeforeDrift + 1);
    expect(resolveMutation).not.toHaveBeenCalled();
    expect(redactProfile).not.toHaveBeenCalled();
    db.prepare(
      `UPDATE display_profiles SET current_display_name = ?
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).run(groupDisplay, canonicalUserId, groupId);
    const staleReplay = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(firstGroupPreview.previewHandle),
    });
    expect(staleReplay.status).toBe(409);
    expect(previewRead).toHaveBeenCalledTimes(previewReadsBeforeDrift + 1);

    const notFoundPreview = await createPreview(groupDetailPath);
    redactProfile.mockReturnValueOnce({ outcome: 'not_found' });
    const ownerNotFound = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(notFoundPreview.previewHandle),
    });
    expect(ownerNotFound.status).toBe(404);
    expect(await ownerNotFound.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const staleOwnerPreview = await createPreview(groupDetailPath);
    redactProfile.mockReturnValueOnce({ outcome: 'stale' });
    const ownerStale = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(staleOwnerPreview.previewHandle),
    });
    expect(ownerStale.status).toBe(409);
    expect(await ownerStale.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(0);

    const groupPreview = await createPreview(groupDetailPath);
    const groupConfirmationResponse = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(groupPreview.previewHandle),
    });
    expect(groupConfirmationResponse.status).toBe(200);
    const groupConfirmationText = await groupConfirmationResponse.text();
    const groupConfirmation = JSON.parse(groupConfirmationText) as {
      action: string;
      outcome: string;
      target: unknown;
      affectedRows: { displayProfiles: number; nicknameHistory: number; total: number };
      openNicknameHistoryRowsClosed: number;
      redactedAt: string;
      durableEffects: string[];
      privacyConsequences: string[];
      evidence: { auditEvent: string; reasonCode: string };
      rollback: { supported: false; boundary: string };
    };
    expect(groupConfirmation).toEqual({
      action: 'display_profile.redact',
      outcome: 'redacted',
      target: groupPreview.target,
      affectedRows: groupPreview.expected.affectedRows,
      openNicknameHistoryRowsClosed: groupPreview.current.openNicknameHistoryRows,
      redactedAt: expect.any(String),
      durableEffects: groupPreview.expected.durableEffects,
      privacyConsequences: groupPreview.expected.privacyConsequences,
      evidence: {
        auditEvent: 'display_profile.redact',
        reasonCode: 'governance_http_display_profile_redaction_confirmed',
      },
      rollback: groupPreview.rollback,
    });
    const groupRedactedAt = Date.parse(groupConfirmation.redactedAt);
    expect(Number.isNaN(groupRedactedAt)).toBe(false);
    expect(redactProfile).toHaveBeenLastCalledWith({
      canonicalUserId,
      groupId,
      targetId: groupTargetId,
      expectedSnapshot: groupPreview.current,
      reasonCode: 'governance_http_display_profile_redaction_confirmed',
    });
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(canonicalUserId, groupId)).toEqual({
      current_display_name: '[redacted]',
      observed_at: groupRedactedAt,
      trust: 'user_set',
    });
    expect(db.prepare(
      `SELECT display_name, observed_until FROM nickname_history WHERE id = ?`,
    ).get(historyId)).toEqual({
      display_name: '[redacted]',
      observed_until: groupRedactedAt,
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(1);

    const successfulReplay = await fetch(`${origin}${groupConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(groupPreview.previewHandle),
    });
    expect(successfulReplay.status).toBe(409);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(1);

    const privatePreview = await createPreview(privateDetailPath);
    const privateConfirmationResponse = await fetch(`${origin}${privateConfirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(privatePreview.previewHandle),
    });
    expect(privateConfirmationResponse.status).toBe(200);
    const privateConfirmationText = await privateConfirmationResponse.text();
    const privateConfirmation = JSON.parse(privateConfirmationText) as {
      affectedRows: { displayProfiles: number; nicknameHistory: number; total: number };
      openNicknameHistoryRowsClosed: number;
      redactedAt: string;
    };
    expect(privateConfirmation).toMatchObject({
      affectedRows: { displayProfiles: 1, nicknameHistory: 0, total: 1 },
      openNicknameHistoryRowsClosed: 0,
    });
    expect(redactProfile).toHaveBeenLastCalledWith({
      canonicalUserId,
      targetId: privateTargetId,
      expectedSnapshot: privatePreview.current,
      reasonCode: 'governance_http_display_profile_redaction_confirmed',
    });
    expect(db.prepare(
      `SELECT current_display_name, trust FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ''`,
    ).get(canonicalUserId)).toEqual({
      current_display_name: '[redacted]',
      trust: 'user_set',
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(2);

    expect(resolveMutation).toHaveBeenCalledWith({ scope, targetId: groupTargetId });
    expect(resolveMutation).toHaveBeenCalledWith({ scope, targetId: privateTargetId });
    expect(unlinkAccount).not.toHaveBeenCalled();
    for (const responseText of [groupConfirmationText, privateConfirmationText]) {
      for (const rawValue of [
        canonicalUserId,
        groupId,
        historyId,
        platformId,
        secret,
        privateDisplay,
        groupDisplay,
        historyDisplay,
        sessionDigest,
        privateTargetId,
        groupTargetId,
        privateResourceHandle,
        groupResourceHandle,
        groupPreview.previewHandle,
        privatePreview.previewHandle,
      ]) {
        expect(responseText).not.toContain(rawValue);
      }
    }
    const auditRows = db.prepare(
      `SELECT summary, details, redacted FROM audit_log
        WHERE event_type = 'display_profile.redact' ORDER BY timestamp ASC`,
    ).all();
    expect(auditRows).toHaveLength(2);
    expect(auditRows.every((row) => (row as { redacted: number }).redacted === 1)).toBe(true);
    const serializedAuditDisplay = JSON.stringify(auditRows);
    expect(serializedAuditDisplay).not.toContain(canonicalUserId);
    expect(serializedAuditDisplay).not.toContain(groupId);
    expect(serializedAuditDisplay).not.toContain(platformId);
    expect(serializedAuditDisplay).not.toContain(secret);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues platform-account unlink preview authority without mutation', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const activeAccountId = '913680247';
    const disabledAccountId = '924791358';
    const malformedAccountId = '935802469';
    const missingAccountId = '946913570';
    const secret = 'sk-platformaccountpreviewabcdefghijklmnopqrstuvwxyz12';
    const activeUserId = `platform-account-preview-user-qq-13579-${secret}`;
    const disabledUserId = 'platform-account-preview-disabled-user';
    const malformedUserId = 'platform-account-preview-malformed-user';
    const previewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getPlatformAccountUnlinkPreview',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-24T00:00:00.000Z');
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    for (const canonicalUserId of [activeUserId, disabledUserId, malformedUserId]) {
      insertUser.run(canonicalUserId, now, now);
    }
    const insertAccount = db.prepare(
      `INSERT INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES ('qq', ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAccount.run(
      activeAccountId,
      activeUserId,
      'private',
      'owner_verified',
      'active',
      now - 100,
      now,
    );
    insertAccount.run(
      disabledAccountId,
      disabledUserId,
      'group_member',
      'observed',
      'disabled',
      now - 200,
      now - 10,
    );
    db.pragma('ignore_check_constraints = ON');
    insertAccount.run(
      malformedAccountId,
      malformedUserId,
      'invalid_type',
      'observed',
      'active',
      now - 300,
      now - 20,
    );
    db.pragma('ignore_check_constraints = OFF');

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/identity/platform-accounts/unlink`;
    const requestBody = (platformAccountId: string): string => JSON.stringify({
      action: 'unlink',
      platform: 'qq',
      platformAccountId,
    });
    const unauthenticated = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: requestBody(activeAccountId),
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(previewRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': session.csrfToken,
    };
    const missingCsrf = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-CSRF': '' },
      body: requestBody(activeAccountId),
    });
    expect(missingCsrf.status).toBe(403);
    const wrongOrigin = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...mutationHeaders, Origin: 'http://127.0.0.1:1' },
      body: requestBody(activeAccountId),
    });
    expect(wrongOrigin.status).toBe(403);
    const wrongContentType = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'Content-Type': 'text/plain' },
      body: requestBody(activeAccountId),
    });
    expect(wrongContentType.status).toBe(400);
    const malformedJson = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    const oversized = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        action: 'unlink',
        platform: 'qq',
        platformAccountId: '9'.repeat(5_000),
      }),
    });
    expect(oversized.status).toBe(413);
    const queried = await fetch(`${origin}${path}?force=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody(activeAccountId),
    });
    expect(queried.status).toBe(400);
    const scoped = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-Scope': 's'.repeat(43) },
      body: requestBody(activeAccountId),
    });
    expect(scoped.status).toBe(400);
    expect(previewRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    for (const body of [
      null,
      [],
      {},
      { action: 'delete', platform: 'qq', platformAccountId: activeAccountId },
      { action: 'unlink', platform: 'discord', platformAccountId: activeAccountId },
      { action: 'unlink', platform: 'qq', platformAccountId: '' },
      { action: 'unlink', platform: 'qq', platformAccountId: '1234' },
      { action: 'unlink', platform: 'qq', platformAccountId: '01234' },
      { action: 'unlink', platform: 'qq', platformAccountId: '1234567890123' },
      { action: 'unlink', platform: 'qq', platformAccountId: ` ${activeAccountId}` },
      {
        action: 'unlink',
        platform: 'qq',
        platformAccountId: activeAccountId,
        reason: 'caller-controlled',
      },
    ]) {
      const invalid = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(previewRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    for (const platformAccountId of [
      missingAccountId,
      disabledAccountId,
      malformedAccountId,
    ]) {
      const missing = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: requestBody(platformAccountId),
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe(JSON.stringify({ error: 'not_found' }));
    }
    expect(previewRead).toHaveBeenCalledTimes(3);
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    db.pragma('ignore_check_constraints = ON');
    db.prepare(
      `UPDATE platform_accounts SET account_type = 'private'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(malformedAccountId);
    db.pragma('ignore_check_constraints = OFF');

    const changesBeforePreviews = db.prepare('SELECT total_changes()').pluck().get();
    const previewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody(activeAccountId),
    });
    expect(previewResponse.status).toBe(201);
    const previewText = await previewResponse.text();
    const preview = JSON.parse(previewText) as {
      action: string;
      account: {
        fingerprint: string;
        platform: string;
        accountType: string;
        verifiedLevel: string;
        status: string;
        firstSeenAt: string;
        lastSeenAt: string;
      };
      current: { snapshotFingerprint: string };
      expected: {
        status: string;
        durableEffects: string[];
        identityConsequences: string[];
        privacyConsequences: string[];
      };
      rollback: { supported: false; boundary: string };
      previewDigest: string;
      resourceHandle: string;
      resourceExpiresAt: number;
      previewHandle: string;
      previewExpiresAt: number;
    };
    expect(preview).toEqual({
      action: 'identity.platform_account.unlink',
      account: {
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        platform: 'qq',
        accountType: 'private',
        verifiedLevel: 'owner_verified',
        status: 'active',
        firstSeenAt: new Date(now - 100).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
      },
      current: { snapshotFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) },
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
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resourceHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      resourceExpiresAt: expect.any(Number),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: expect.any(Number),
    });
    expect(Object.keys(preview).sort()).toEqual([
      'account',
      'action',
      'current',
      'expected',
      'previewDigest',
      'previewExpiresAt',
      'previewHandle',
      'resourceExpiresAt',
      'resourceHandle',
      'rollback',
    ]);
    const resourceId = JSON.stringify({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });
    expect(issueResourceHandle).toHaveBeenLastCalledWith({
      sessionId: sessionDigest,
      sessionExpiresAt: preview.resourceExpiresAt,
      purpose: 'governance.identity.platform_account.unlink',
      resourceKind: 'platform_account',
      resourceId,
      scope: { kind: 'system' },
    });
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: sessionDigest,
      sessionExpiresAt: preview.resourceExpiresAt,
      actor: { kind: 'local_admin' },
      action: 'identity.platform_account.unlink',
      resourceKind: 'platform_account',
      resourceId,
      scope: { kind: 'system' },
      expectedState: preview.current.snapshotFingerprint,
      expectedRevisionNumber: 1,
      previewDigest: preview.previewDigest,
    });
    const resourceIssueOrder = issueResourceHandle.mock.invocationCallOrder.at(-1) ?? 0;
    const previewIssueOrder = issuePreviewHandle.mock.invocationCallOrder.at(-1) ?? 0;
    expect(resourceIssueOrder).toBeLessThan(previewIssueOrder);
    for (const rawValue of [activeAccountId, activeUserId, disabledAccountId, secret]) {
      expect(previewText).not.toContain(rawValue);
    }

    const repeatedResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: requestBody(activeAccountId),
    });
    expect(repeatedResponse.status).toBe(201);
    const repeatedText = await repeatedResponse.text();
    const repeated = JSON.parse(repeatedText) as typeof preview;
    expect(repeated).toMatchObject({
      ...preview,
      resourceHandle: preview.resourceHandle,
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(repeated.previewHandle).not.toBe(preview.previewHandle);
    expect(issueResourceHandle).toHaveBeenCalledTimes(2);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(2);
    expect(previewRead).toHaveBeenCalledTimes(5);
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforePreviews);
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(activeAccountId)).toEqual({ status: 'active' });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(0);

    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('confirms platform-account unlink once through exact preview authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const targetAccountId = '957024681';
    const driftAccountId = '968135792';
    const inactiveAccountId = '979246813';
    const secret = 'sk-platformaccountconfirmabcdefghijklmnopqrstuvwxyz12';
    const targetUserId = `platform-account-confirm-user-qq-24680-${secret}`;
    const driftUserId = 'platform-account-confirm-drift-user';
    const inactiveUserId = 'platform-account-confirm-inactive-user';
    const previewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getPlatformAccountUnlinkPreview',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const unlinkAccount = vi.spyOn(
      GovernanceService.prototype,
      'unlinkPlatformAccountAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-25T00:00:00.000Z');
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    for (const canonicalUserId of [targetUserId, driftUserId, inactiveUserId]) {
      insertUser.run(canonicalUserId, now, now);
    }
    const insertAccount = db.prepare(
      `INSERT INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES ('qq', ?, ?, ?, ?, 'active', ?, ?)`,
    );
    insertAccount.run(
      targetAccountId,
      targetUserId,
      'private',
      'owner_verified',
      now - 300,
      now - 200,
    );
    insertAccount.run(
      driftAccountId,
      driftUserId,
      'group_member',
      'observed',
      now - 500,
      now - 400,
    );
    insertAccount.run(
      inactiveAccountId,
      inactiveUserId,
      'temp_session',
      'self_claimed',
      now - 700,
      now - 600,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const previewPath = `${API_PREFIX}/identity/platform-accounts/unlink`;
    const confirmPath = `${previewPath}/confirm`;
    const confirmationBody = (resourceHandle: string, previewHandle: string): string =>
      JSON.stringify({ confirm: true, resourceHandle, previewHandle });
    const unauthenticated = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: confirmationBody('r'.repeat(43), 'p'.repeat(43)),
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(previewRead).not.toHaveBeenCalled();
    expect(unlinkAccount).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': session.csrfToken,
    };
    type UnlinkPreview = {
      action: 'identity.platform_account.unlink';
      account: {
        fingerprint: string;
        platform: 'qq';
        accountType: 'private' | 'group_member' | 'temp_session';
        verifiedLevel: 'observed' | 'self_claimed' | 'owner_verified';
        status: 'active';
        firstSeenAt: string;
        lastSeenAt: string;
      };
      current: { snapshotFingerprint: string };
      expected: {
        status: 'disabled';
        durableEffects: string[];
        identityConsequences: string[];
        privacyConsequences: string[];
      };
      rollback: { supported: false; boundary: string };
      previewDigest: string;
      resourceHandle: string;
      resourceExpiresAt: number;
      previewHandle: string;
      previewExpiresAt: number;
    };
    const createPreview = async (platformAccountId: string): Promise<UnlinkPreview> => {
      const response = await fetch(`${origin}${previewPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ action: 'unlink', platform: 'qq', platformAccountId }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<UnlinkPreview>;
    };
    const targetPreview = await createPreview(targetAccountId);
    const targetResourceId = JSON.stringify({
      platform: 'qq',
      platformAccountId: targetAccountId,
    });
    const resolveCountBeforeBoundary = resolveResourceHandle.mock.calls.length;
    const consumeCountBeforeBoundary = consumePreviewHandle.mock.calls.length;
    const previewCountBeforeBoundary = previewRead.mock.calls.length;
    const missingCsrf = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-CSRF': '' },
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(missingCsrf.status).toBe(403);
    const wrongOrigin = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, Origin: 'http://127.0.0.1:1' },
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(wrongOrigin.status).toBe(403);
    const wrongContentType = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'Content-Type': 'text/plain' },
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(wrongContentType.status).toBe(400);
    const malformedJson = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    const oversized = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        resourceHandle: 'r'.repeat(5_000),
        previewHandle: targetPreview.previewHandle,
      }),
    });
    expect(oversized.status).toBe(413);
    const queried = await fetch(`${origin}${confirmPath}?force=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(queried.status).toBe(400);
    const scoped = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'X-LetheBot-Scope': 's'.repeat(43) },
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(scoped.status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { confirm: false, resourceHandle: targetPreview.resourceHandle,
        previewHandle: targetPreview.previewHandle },
      { confirm: true, resourceHandle: 'malformed',
        previewHandle: targetPreview.previewHandle },
      { confirm: true, resourceHandle: targetPreview.resourceHandle,
        previewHandle: 'malformed' },
      { confirm: true, resourceHandle: targetPreview.resourceHandle,
        previewHandle: targetPreview.previewHandle, reason: 'caller' },
    ]) {
      const invalid = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resolveCountBeforeBoundary);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(consumeCountBeforeBoundary);
    expect(previewRead).toHaveBeenCalledTimes(previewCountBeforeBoundary);
    expect(unlinkAccount).not.toHaveBeenCalled();

    const unknownResource = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody('z'.repeat(43), targetPreview.previewHandle),
    });
    expect(unknownResource.status).toBe(404);
    expect(await unknownResource.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(consumePreviewHandle).toHaveBeenCalledTimes(consumeCountBeforeBoundary);

    const secondSession = await loginGovernance(origin);
    const crossSession = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        Cookie: secondSession.cookie,
        'X-LetheBot-CSRF': secondSession.csrfToken,
      },
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(crossSession.status).toBe(404);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(consumeCountBeforeBoundary);

    const resourceRegistry = issueResourceHandle.mock.contexts[0] as
      GovernanceResourceHandleRegistry;
    const issuePrivateResource = (
      resourceId: string,
      purpose = 'governance.identity.platform_account.unlink',
      resourceKind = 'platform_account',
      scope: { kind: 'system' | 'global' } = { kind: 'system' },
    ): string => resourceRegistry.issue({
      sessionId: sessionDigest,
      sessionExpiresAt: targetPreview.resourceExpiresAt,
      purpose,
      resourceKind,
      resourceId,
      scope,
    }).handle;
    const invalidResourceHandles = [
      issuePrivateResource(targetResourceId, 'governance.memory.records.read'),
      issuePrivateResource(targetResourceId, undefined, 'memory_record'),
      issuePrivateResource(targetResourceId, undefined, undefined, { kind: 'global' }),
      issuePrivateResource('not-json'),
      issuePrivateResource(JSON.stringify({
        platform: 'qq',
        platformAccountId: targetAccountId,
        extra: true,
      })),
      issuePrivateResource(JSON.stringify({
        platformAccountId: targetAccountId,
        platform: 'qq',
      })),
      issuePrivateResource(JSON.stringify({
        platform: 'qq',
        platformAccountId: `0${targetAccountId.slice(1)}`,
      })),
    ];
    for (const resourceHandle of invalidResourceHandles) {
      const invalidResource = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: confirmationBody(resourceHandle, targetPreview.previewHandle),
      });
      expect(invalidResource.status).toBe(404);
      expect(await invalidResource.text()).toBe(JSON.stringify({ error: 'not_found' }));
    }
    expect(consumePreviewHandle).toHaveBeenCalledTimes(consumeCountBeforeBoundary);
    expect(previewRead).toHaveBeenCalledTimes(previewCountBeforeBoundary);
    expect(unlinkAccount).not.toHaveBeenCalled();

    const unknownPreview = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(targetPreview.resourceHandle, 'y'.repeat(43)),
    });
    expect(unknownPreview.status).toBe(404);
    expect(await unknownPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));

    const previewRegistry = issuePreviewHandle.mock.contexts[0] as
      GovernancePreviewHandleRegistry;
    const issuePrivatePreview = (overrides: {
      action?: string;
      resourceId?: string;
      expectedState?: string;
      expectedRevisionNumber?: number;
      previewDigest?: string;
    }): string => previewRegistry.issue({
      sessionId: sessionDigest,
      sessionExpiresAt: targetPreview.resourceExpiresAt,
      actor: { kind: 'local_admin' },
      action: overrides.action ?? 'identity.platform_account.unlink',
      resourceKind: 'platform_account',
      resourceId: overrides.resourceId ?? targetResourceId,
      scope: { kind: 'system' },
      expectedState: overrides.expectedState ?? targetPreview.current.snapshotFingerprint,
      expectedRevisionNumber: overrides.expectedRevisionNumber ?? 1,
      previewDigest: overrides.previewDigest ?? targetPreview.previewDigest,
    }).handle;
    for (const previewHandle of [
      issuePrivatePreview({ action: 'memory.record.forget' }),
      issuePrivatePreview({
        resourceId: JSON.stringify({ platform: 'qq', platformAccountId: driftAccountId }),
      }),
    ]) {
      const crossAuthority = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: confirmationBody(targetPreview.resourceHandle, previewHandle),
      });
      expect(crossAuthority.status).toBe(404);
      expect(await crossAuthority.text()).toBe(JSON.stringify({ error: 'not_found' }));
    }
    expect(previewRead).toHaveBeenCalledTimes(previewCountBeforeBoundary);
    expect(unlinkAccount).not.toHaveBeenCalled();

    for (const previewHandle of [
      issuePrivatePreview({ expectedState: '0'.repeat(64) }),
      issuePrivatePreview({ expectedRevisionNumber: 2 }),
      issuePrivatePreview({ previewDigest: 'f'.repeat(64) }),
    ]) {
      const mismatched = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: confirmationBody(targetPreview.resourceHandle, previewHandle),
      });
      expect(mismatched.status).toBe(409);
      expect(await mismatched.text()).toBe(JSON.stringify({ error: 'conflict' }));
    }
    expect(unlinkAccount).not.toHaveBeenCalled();

    const driftPreview = await createPreview(driftAccountId);
    db.prepare(
      `UPDATE platform_accounts SET last_seen_at = last_seen_at + 1
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(driftAccountId);
    const drifted = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(driftPreview.resourceHandle, driftPreview.previewHandle),
    });
    expect(drifted.status).toBe(409);
    expect(await drifted.text()).toBe(JSON.stringify({ error: 'conflict' }));

    const inactivePreview = await createPreview(inactiveAccountId);
    db.prepare(
      `UPDATE platform_accounts SET status = 'disabled'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(inactiveAccountId);
    const inactive = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(inactivePreview.resourceHandle, inactivePreview.previewHandle),
    });
    expect(inactive.status).toBe(409);
    expect(await inactive.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(unlinkAccount).not.toHaveBeenCalled();

    unlinkAccount.mockReturnValueOnce({ outcome: 'stale' });
    const serviceStale = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(targetPreview.resourceHandle, targetPreview.previewHandle),
    });
    expect(serviceStale.status).toBe(409);
    expect(await serviceStale.text()).toBe(JSON.stringify({ error: 'conflict' }));
    const notFoundPreview = await createPreview(targetAccountId);
    unlinkAccount.mockReturnValueOnce({ outcome: 'not_found' });
    const serviceNotFound = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(notFoundPreview.resourceHandle, notFoundPreview.previewHandle),
    });
    expect(serviceNotFound.status).toBe(409);
    expect(await serviceNotFound.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId)).toEqual({ status: 'active' });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(0);

    const successPreview = await createPreview(targetAccountId);
    const unlinkCallsBeforeSuccess = unlinkAccount.mock.calls.length;
    const success = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(successPreview.resourceHandle, successPreview.previewHandle),
    });
    expect(success.status).toBe(200);
    const successText = await success.text();
    const successBody = JSON.parse(successText) as {
      action: string;
      outcome: string;
      account: Record<string, unknown>;
      affectedRows: { platformAccounts: number };
      disabledAt: string;
      durableEffects: string[];
      identityConsequences: string[];
      privacyConsequences: string[];
      evidence: { auditEvent: string; reasonCode: string };
      rollback: { supported: boolean; boundary: string };
    };
    expect(successBody).toEqual({
      action: 'identity.platform_account.unlink',
      outcome: 'unlinked',
      account: {
        ...successPreview.account,
        status: 'disabled',
      },
      affectedRows: { platformAccounts: 1 },
      disabledAt: expect.any(String),
      durableEffects: successPreview.expected.durableEffects,
      identityConsequences: successPreview.expected.identityConsequences,
      privacyConsequences: successPreview.expected.privacyConsequences,
      evidence: {
        auditEvent: 'identity.platform_account.unlinked',
        reasonCode: 'governance_http_platform_account_unlink_confirmed',
      },
      rollback: successPreview.rollback,
    });
    expect(Number.isNaN(Date.parse(successBody.disabledAt))).toBe(false);
    expect(Object.keys(successBody).sort()).toEqual([
      'account',
      'action',
      'affectedRows',
      'disabledAt',
      'durableEffects',
      'evidence',
      'identityConsequences',
      'outcome',
      'privacyConsequences',
      'rollback',
    ]);
    expect(unlinkAccount).toHaveBeenCalledTimes(unlinkCallsBeforeSuccess + 1);
    expect(unlinkAccount).toHaveBeenLastCalledWith({
      platform: 'qq',
      platformAccountId: targetAccountId,
      expectedSnapshot: successPreview.current,
      reasonCode: 'governance_http_platform_account_unlink_confirmed',
    });
    const resolveOrder = resolveResourceHandle.mock.invocationCallOrder.at(-1) ?? 0;
    const consumeOrder = consumePreviewHandle.mock.invocationCallOrder.at(-1) ?? 0;
    const previewOrder = previewRead.mock.invocationCallOrder.at(-1) ?? 0;
    const unlinkOrder = unlinkAccount.mock.invocationCallOrder.at(-1) ?? 0;
    expect(resolveOrder).toBeLessThan(consumeOrder);
    expect(consumeOrder).toBeLessThan(previewOrder);
    expect(previewOrder).toBeLessThan(unlinkOrder);

    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId)).toEqual({ status: 'disabled' });
    const targetAudit = db.prepare(
      `SELECT timestamp, summary, details, redacted
         FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).get() as { timestamp: number; summary: string; details: string; redacted: number };
    expect(new Date(targetAudit.timestamp).toISOString()).toBe(successBody.disabledAt);
    expect(targetAudit).toMatchObject({
      summary: 'Governance HTTP disabled one platform account mapping',
      redacted: 1,
    });
    expect(JSON.parse(targetAudit.details)).toMatchObject({
      platform: 'qq',
      previousStatus: 'active',
      newStatus: 'disabled',
      reasonCode: 'governance_http_platform_account_unlink_confirmed',
      redaction: 'no_raw_platform_account_id',
    });
    for (const rawValue of [
      targetAccountId,
      targetUserId,
      secret,
      sessionDigest,
      targetResourceId,
      successPreview.resourceHandle,
      successPreview.previewHandle,
    ]) {
      expect(successText).not.toContain(rawValue);
      expect(targetAudit.summary).not.toContain(rawValue);
      expect(targetAudit.details).not.toContain(rawValue);
    }
    expect(await new IdentityRepository(db).findCanonicalUserId(
      'qq',
      targetAccountId,
    )).toBeNull();

    const callsBeforeReplay = unlinkAccount.mock.calls.length;
    const replay = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: confirmationBody(successPreview.resourceHandle, successPreview.previewHandle),
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(unlinkAccount).toHaveBeenCalledTimes(callsBeforeReplay);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(1);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues exact-group summary-policy scope handles only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const secret = 'sk-summarypolicyhttpabcdefghijklmnopqrstuvwxyz123456';
    const groupName = 'Synthetic summary policy group';
    const chatOnlyGroupId = 'qq-group-12345';
    const policyOnlyGroupId = 'qq-group-23456';
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listGroupSummaryPolicyScopeHandles',
    );
    const statusRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getGroupSummaryPolicyForScope',
    );
    const changePolicy = vi.spyOn(
      GovernanceService.prototype,
      'setGroupSummaryPolicyAsLocalAdmin',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-17T00:00:00.000Z');
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      'raw-summary-policy-http-chat',
      now,
      chatOnlyGroupId,
      JSON.stringify({ groupName, token: secret }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
    ).run(
      'chat-summary-policy-http',
      'raw-summary-policy-http-chat',
      'message-summary-policy-http',
      chatOnlyGroupId,
      chatOnlyGroupId,
      'qq-user-summary-policy-http',
      `${groupName} password=${secret}`,
      now,
    );
    db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, 'enabled', 1, ?, ?, ?)`,
    ).run(policyOnlyGroupId, now, now, now + 1);

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/group-summary/scopes`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();
    expect(statusRead).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?group=${chatOnlyGroupId}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const catalog = JSON.parse(responseText) as {
      entries: Array<{
        fingerprint: string;
        scopeKind: string;
        label: string;
        handle: string;
        expiresAt: number;
      }>;
      truncated: boolean;
    };
    expect(catalog).toEqual({
      entries: [
        {
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
          scopeKind: 'group',
          label: 'Group summary policy',
          handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          expiresAt: expect.any(Number),
        },
        {
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
          scopeKind: 'group',
          label: 'Group summary policy',
          handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          expiresAt: expect.any(Number),
        },
      ],
      truncated: false,
    });
    catalog.entries.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
      ]);
    });
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(catalogRead).toHaveBeenCalledWith(expect.any(Function));
    expect(issueScopeHandle).toHaveBeenCalledTimes(2);
    const expectedScopes = [
      { kind: 'group' as const, groupId: policyOnlyGroupId },
      { kind: 'group' as const, groupId: chatOnlyGroupId },
    ];
    expect(issueScopeHandle.mock.calls.slice(0, 2).map(([input]) => input)).toEqual(
      expectedScopes.map((scope) => ({
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.group_summary_policy.status.read',
        scope,
      })),
    );
    const registry = issueScopeHandle.mock.contexts[0] as GovernanceScopeHandleRegistry;
    catalog.entries.forEach((entry, index) => {
      expect(registry.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.group_summary_policy.status.read',
      })).toEqual(expectedScopes[index]);
      expect(registry.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.privacy.preferences.read',
      })).toBeNull();
    });
    for (const rawValue of [
      secret,
      groupName,
      sessionDigest,
      chatOnlyGroupId,
      policyOnlyGroupId,
      'enabled',
    ]) {
      expect(responseText).not.toContain(rawValue);
    }

    const otherSession = await loginGovernance(origin);
    const otherSessionDigest = digestSessionCookie(otherSession.cookie);
    catalog.entries.forEach((entry) => {
      expect(registry.resolve({
        sessionId: otherSessionDigest,
        handle: entry.handle,
        purpose: 'governance.group_summary_policy.status.read',
      })).toBeNull();
    });

    const statusPath = `${API_PREFIX}/group-summary/policy`;
    const invalidMutation = await fetch(`${origin}${statusPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': session.csrfToken,
        'X-LetheBot-Scope': catalog.entries[0]?.handle ?? '',
      },
      body: JSON.stringify({ action: 'enable' }),
    });
    expect(invalidMutation.status).toBe(400);
    expect(statusRead).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const legacyCatalog = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(legacyCatalog.status).toBe(200);
    expect(await legacyCatalog.json()).toEqual({ entries: [], truncated: false });

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(catalogRead).toHaveBeenCalledTimes(2);
    expect(issueScopeHandle).toHaveBeenCalledTimes(4);
    expect(statusRead).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('reads exact-group summary-policy status only through current scope authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const secret = 'sk-summarypolicystatusabcdefghijklmnopqrstuvwxyz1234';
    const groupName = 'Synthetic scoped summary policy group';
    const enabledGroupId = 'qq-group-34567';
    const disabledGroupId = 'qq-group-45678';
    const defaultOffGroupId = 'qq-group-56789';
    const statusRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getGroupSummaryPolicyForScope',
    );
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listGroupSummaryPolicyScopeHandles',
    );
    const resolveScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'resolve',
    );
    const issueScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'issue',
    );
    const changePolicy = vi.spyOn(
      GovernanceService.prototype,
      'setGroupSummaryPolicyAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-18T00:00:00.000Z');
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      'raw-summary-policy-status-default-off',
      now + 100,
      defaultOffGroupId,
      JSON.stringify({ groupName, token: secret }),
      now + 100,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
    ).run(
      'chat-summary-policy-status-default-off',
      'raw-summary-policy-status-default-off',
      'message-summary-policy-status-default-off',
      defaultOffGroupId,
      defaultOffGroupId,
      'qq-user-summary-policy-status',
      `${groupName} password=${secret}`,
      now + 100,
    );
    db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, 'enabled', 2, ?, ?, ?), (?, 'disabled', 3, NULL, ?, ?)`,
    ).run(
      enabledGroupId,
      now + 400,
      now + 200,
      now + 300,
      disabledGroupId,
      now + 150,
      now + 200,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/group-summary/policy`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(statusRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const catalogResponse = await fetch(`${origin}${API_PREFIX}/group-summary/scopes`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
      truncated: boolean;
    };
    expect(catalog.entries).toHaveLength(3);
    expect(catalog.truncated).toBe(false);
    expect(catalogRead).toHaveBeenCalledTimes(1);
    const enabledHandle = catalog.entries[0]?.handle ?? '';
    const disabledHandle = catalog.entries[1]?.handle ?? '';
    const defaultOffHandle = catalog.entries[2]?.handle ?? '';
    expect(enabledHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(disabledHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(defaultOffHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();

    const missingScope = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingScope.status).toBe(400);
    expect(statusRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const malformedScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedScope.status).toBe(400);
    expect(statusRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const withQuery = await fetch(`${origin}${path}?groupId=${enabledGroupId}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': enabledHandle,
      },
    });
    expect(withQuery.status).toBe(400);
    expect(statusRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownScope.status).toBe(404);
    expect(statusRead).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const crossSession = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': enabledHandle,
      },
    });
    expect(crossSession.status).toBe(404);
    expect(statusRead).not.toHaveBeenCalled();

    const scopeRegistry = issueScopeHandle.mock.contexts[0] as GovernanceScopeHandleRegistry;
    const scopeExpiresAt = catalog.entries[0]?.expiresAt ?? 0;
    expect(Number.isSafeInteger(scopeExpiresAt)).toBe(true);
    const crossPurposeScope = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: scopeExpiresAt,
      purpose: 'governance.privacy.preferences.read',
      scope: { kind: 'group', groupId: enabledGroupId },
    });
    const crossPurpose = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': crossPurposeScope.handle,
      },
    });
    expect(crossPurpose.status).toBe(404);
    expect(statusRead).not.toHaveBeenCalled();

    const readStatus = async (handle: string): Promise<{
      response: Response;
      text: string;
    }> => {
      const response = await fetch(`${origin}${path}`, {
        headers: {
          Connection: 'close',
          Cookie: firstSession.cookie,
          'X-LetheBot-Scope': handle,
        },
      });
      return { response, text: await response.text() };
    };

    const enabled = await readStatus(enabledHandle);
    expect(enabled.response.status).toBe(200);
    expect(JSON.parse(enabled.text)).toEqual({
      state: 'enabled',
      stored: true,
      generation: 2,
      eligibleAfter: new Date(now + 400).toISOString(),
      createdAt: new Date(now + 200).toISOString(),
      updatedAt: new Date(now + 300).toISOString(),
    });
    expect(statusRead).toHaveBeenLastCalledWith({
      kind: 'group',
      groupId: enabledGroupId,
    });

    const disabled = await readStatus(disabledHandle);
    expect(disabled.response.status).toBe(200);
    expect(JSON.parse(disabled.text)).toEqual({
      state: 'disabled',
      stored: true,
      generation: 3,
      eligibleAfter: null,
      createdAt: new Date(now + 150).toISOString(),
      updatedAt: new Date(now + 200).toISOString(),
    });
    expect(statusRead).toHaveBeenLastCalledWith({
      kind: 'group',
      groupId: disabledGroupId,
    });

    const defaultOff = await readStatus(defaultOffHandle);
    expect(defaultOff.response.status).toBe(200);
    expect(JSON.parse(defaultOff.text)).toEqual({
      state: 'disabled',
      stored: false,
      generation: null,
      eligibleAfter: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(statusRead).toHaveBeenLastCalledWith({
      kind: 'group',
      groupId: defaultOffGroupId,
    });

    for (const text of [enabled.text, disabled.text, defaultOff.text]) {
      expect(Object.keys(JSON.parse(text) as Record<string, unknown>).sort()).toEqual([
        'createdAt',
        'eligibleAfter',
        'generation',
        'state',
        'stored',
        'updatedAt',
      ]);
      for (const rawValue of [
        secret,
        groupName,
        firstSessionDigest,
        enabledGroupId,
        disabledGroupId,
        defaultOffGroupId,
      ]) {
        expect(text).not.toContain(rawValue);
      }
    }

    const repeated = await readStatus(enabledHandle);
    expect(repeated.response.status).toBe(200);
    expect(repeated.text).toBe(enabled.text);

    statusRead.mockResolvedValueOnce(null);
    const defensiveMissing = await readStatus(enabledHandle);
    expect(defensiveMissing.response.status).toBe(404);
    expect(defensiveMissing.text).toBe(JSON.stringify({ error: 'not_found' }));

    const invalidMutation = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': enabledHandle,
      },
      body: JSON.stringify({ action: 'enable' }),
    });
    expect(invalidMutation.status).toBe(400);
    expect(changePolicy).not.toHaveBeenCalled();
    expect(statusRead).toHaveBeenCalledTimes(5);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues exact-group summary-policy change previews only through current scope authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const storedGroupId = 'qq-group-67890';
    const implicitGroupId = 'qq-group-78901';
    const secret = 'sk-summary-policy-preview-abcdefghijklmnopqrstuvwxyz';
    const previewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getGroupSummaryPolicyChangePreviewForScope',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const issuePreviewHandle = vi.spyOn(GovernancePreviewHandleRegistry.prototype, 'issue');
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const changePolicy = vi.spyOn(
      GovernanceService.prototype,
      'setGroupSummaryPolicyAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-19T00:00:00.000Z');
    db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, 'disabled', 3, NULL, ?, ?)`,
    ).run(storedGroupId, now, now + 10);
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      'raw-summary-policy-preview-implicit',
      now + 20,
      implicitGroupId,
      JSON.stringify({ token: secret }),
      now + 20,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
    ).run(
      'chat-summary-policy-preview-implicit',
      'raw-summary-policy-preview-implicit',
      'message-summary-policy-preview-implicit',
      implicitGroupId,
      implicitGroupId,
      'qq-user-summary-policy-preview',
      `Synthetic summary policy preview password=${secret}`,
      now + 20,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/group-summary/policy`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': 'x'.repeat(43),
        'X-LetheBot-Scope': 'y'.repeat(43),
      },
      body: JSON.stringify({ action: 'change', targetState: 'enabled' }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(previewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const catalogResponse = await fetch(`${origin}${API_PREFIX}/group-summary/scopes`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
      truncated: boolean;
    };
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.truncated).toBe(false);
    const findScopeEntry = (groupId: string): { handle: string; expiresAt: number } => {
      const index = issueScopeHandle.mock.calls.findIndex(([input]) => (
        input.scope.kind === 'group' && input.scope.groupId === groupId
      ));
      const entry = catalog.entries[index];
      expect(entry).toBeDefined();
      return entry as { handle: string; expiresAt: number };
    };
    const storedScope = findScopeEntry(storedGroupId);
    const implicitScope = findScopeEntry(implicitGroupId);
    const previewHeaders = {
      Connection: 'close',
      Cookie: firstSession.cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': firstSession.csrfToken,
      'X-LetheBot-Scope': storedScope.handle,
    };
    const previewBody = { action: 'change', targetState: 'enabled' };
    const changesBeforePreviews = db.prepare('SELECT total_changes()').pluck().get();

    const secondSession = await loginGovernance(origin);
    const invalidRequests: Array<Promise<Response>> = [
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { ...previewHeaders, Origin: 'http://127.0.0.1:1' },
        body: JSON.stringify(previewBody),
      }),
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Cookie: firstSession.cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'X-LetheBot-Scope': storedScope.handle,
        },
        body: JSON.stringify(previewBody),
      }),
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { ...previewHeaders, 'X-LetheBot-CSRF': 'malformed' },
        body: JSON.stringify(previewBody),
      }),
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          ...previewHeaders,
          Cookie: secondSession.cookie,
          'X-LetheBot-CSRF': secondSession.csrfToken,
        },
        body: JSON.stringify(previewBody),
      }),
    ];
    const invalidResponses = await Promise.all(invalidRequests);
    expect(invalidResponses.map((response) => response.status)).toEqual([403, 403, 403, 404]);

    const missingScope = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': firstSession.csrfToken,
      },
      body: JSON.stringify(previewBody),
    });
    expect(missingScope.status).toBe(400);
    const malformedScope = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': 'malformed' },
      body: JSON.stringify(previewBody),
    });
    expect(malformedScope.status).toBe(400);
    const unknownScope = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': 'z'.repeat(43) },
      body: JSON.stringify(previewBody),
    });
    expect(unknownScope.status).toBe(404);
    const queried = await fetch(`${origin}${path}?group=${storedGroupId}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(previewBody),
    });
    expect(queried.status).toBe(400);

    const scopeRegistry = issueScopeHandle.mock.contexts[0] as GovernanceScopeHandleRegistry;
    const crossPurposeScope = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: storedScope.expiresAt,
      purpose: 'governance.privacy.preferences.read',
      scope: { kind: 'group', groupId: storedGroupId },
    });
    const crossPurpose = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': crossPurposeScope.handle },
      body: JSON.stringify(previewBody),
    });
    expect(crossPurpose.status).toBe(404);
    const missingContentType = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': storedScope.handle,
      },
      body: JSON.stringify(previewBody),
    });
    expect(missingContentType.status).toBe(400);
    const invalidJson = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { action: 'enable', targetState: 'enabled' },
      { action: 'change', targetState: 'opted_in' },
      { ...previewBody, extra: true },
    ]) {
      const invalidBody = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBody.status).toBe(400);
    }
    const oversized = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ ...previewBody, padding: 'x'.repeat(4_096) }),
    });
    expect(oversized.status).toBe(413);
    expect(previewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const storedPreviewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(previewBody),
    });
    expect(storedPreviewResponse.status).toBe(201);
    const storedPreviewText = await storedPreviewResponse.text();
    const storedPreview = JSON.parse(storedPreviewText) as {
      action: string;
      current: Record<string, unknown>;
      expected: Record<string, unknown>;
      rollback: Record<string, unknown>;
      previewDigest: string;
      previewHandle: string;
      previewExpiresAt: number;
    };
    expect(storedPreview).toEqual({
      action: 'group.summary_policy.change',
      current: {
        state: 'disabled',
        stored: true,
        version: {
          generation: 3,
          updatedAt: new Date(now + 10).toISOString(),
        },
      },
      expected: {
        state: 'enabled',
        generation: 4,
        durableEffects: ['group_summary_policy_upsert', 'audit_event_append'],
        enforcementConsequences: [
          'policy_generation_advanced',
          'pre_enable_sources_excluded',
          'group_summary_generation_and_retrieval_enabled',
        ],
      },
      rollback: {
        supported: true,
        targetState: 'disabled',
        boundary: 'separate_group_summary_policy_change_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: storedScope.expiresAt,
    });
    expect(Object.keys(storedPreview).sort()).toEqual([
      'action',
      'current',
      'expected',
      'previewDigest',
      'previewExpiresAt',
      'previewHandle',
      'rollback',
    ]);
    expect(previewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'group', groupId: storedGroupId },
      targetState: 'enabled',
    });
    expect(previewRead).toHaveBeenCalledTimes(1);
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt: storedScope.expiresAt,
      actor: { kind: 'local_admin' },
      action: 'group.summary_policy.change',
      resourceKind: 'group_summary_policy',
      resourceId: 'policy',
      scope: { kind: 'group', groupId: storedGroupId },
      expectedState: 'disabled',
      expectedRevisionNumber: 3,
      previewDigest: storedPreview.previewDigest,
    });

    const repeatedResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(previewBody),
    });
    expect(repeatedResponse.status).toBe(201);
    const repeatedPreview = await repeatedResponse.json() as typeof storedPreview;
    expect(repeatedPreview.previewDigest).toBe(storedPreview.previewDigest);
    expect(repeatedPreview.previewHandle).not.toBe(storedPreview.previewHandle);
    expect(previewRead).toHaveBeenCalledTimes(2);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(2);

    const implicitResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': implicitScope.handle },
      body: JSON.stringify(previewBody),
    });
    expect(implicitResponse.status).toBe(201);
    const implicitPreview = await implicitResponse.json() as typeof storedPreview;
    expect(implicitPreview.current).toEqual({
      state: 'disabled',
      stored: false,
      version: { generation: null, updatedAt: null },
    });
    expect(implicitPreview.expected).toMatchObject({ state: 'enabled', generation: 1 });
    expect(implicitPreview.previewDigest).not.toBe(storedPreview.previewDigest);
    expect(previewRead).toHaveBeenCalledTimes(3);
    expect(issuePreviewHandle).toHaveBeenLastCalledWith(expect.objectContaining({
      resourceKind: 'group_summary_policy',
      resourceId: 'policy',
      scope: { kind: 'group', groupId: implicitGroupId },
      expectedState: 'disabled',
      expectedRevisionNumber: 1,
      previewDigest: implicitPreview.previewDigest,
    }));

    const noOp = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': implicitScope.handle },
      body: JSON.stringify({ action: 'change', targetState: 'disabled' }),
    });
    expect(noOp.status).toBe(404);
    expect(await noOp.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(previewRead).toHaveBeenCalledTimes(4);
    expect(previewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'group', groupId: implicitGroupId },
      targetState: 'disabled',
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(3);

    const confirmation = await fetch(`${origin}${path}/confirm`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ confirm: true, previewHandle: storedPreview.previewHandle }),
    });
    expect(confirmation.status).toBe(400);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforePreviews);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    for (const rawValue of [storedGroupId, implicitGroupId, secret, firstSessionDigest]) {
      expect(storedPreviewText).not.toContain(rawValue);
    }
  });

  it('confirms exact-group summary-policy changes through current snapshot authority', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const implicitGroupId = 'qq-group-89012';
    const storedDisabledGroupId = 'qq-group-90123';
    const storedEnabledGroupId = 'qq-group-91234';
    const otherGroupId = 'qq-group-92345';
    const pendingJobId = 'summary-policy-confirm-pending';
    const otherPendingJobId = 'summary-policy-confirm-other-pending';
    const secret = 'sk-summary-policy-confirm-abcdefghijklmnopqrstuvwxyz';
    const originalPreviewRead =
      GovernanceQueryService.prototype.getGroupSummaryPolicyChangePreviewForScope;
    const previewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getGroupSummaryPolicyChangePreviewForScope',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const issuePreviewHandle = vi.spyOn(GovernancePreviewHandleRegistry.prototype, 'issue');
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const changePolicy = vi.spyOn(
      GovernanceService.prototype,
      'setGroupSummaryPolicyAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-20T00:00:00.000Z');
    db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES
         (?, 'disabled', 2, NULL, ?, ?),
         (?, 'enabled', 3, ?, ?, ?),
         (?, 'enabled', 1, ?, ?, ?)`,
    ).run(
      storedDisabledGroupId,
      now + 15,
      now + 20,
      storedEnabledGroupId,
      now + 5,
      now + 5,
      now + 10,
      otherGroupId,
      now + 5,
      now + 5,
      now + 8,
    );
    db.prepare(
      `INSERT INTO jobs (
         id, type, payload, status, attempts, max_attempts,
         created_at, updated_at, scheduled_at
       ) VALUES
         (?, 'summary', '{}', 'pending', 0, 3, ?, ?, ?),
         (?, 'summary', '{}', 'pending', 0, 3, ?, ?, ?)`,
    ).run(
      pendingJobId,
      now + 30,
      now + 30,
      now + 30,
      otherPendingJobId,
      now + 30,
      now + 30,
      now + 30,
    );
    db.prepare(
      `INSERT INTO group_summary_job_bindings (
         job_id, group_id, conversation_id, generation,
         eligible_after, created_at
       ) VALUES (?, ?, ?, 3, ?, ?), (?, ?, ?, 1, ?, ?)`,
    ).run(
      pendingJobId,
      storedEnabledGroupId,
      storedEnabledGroupId,
      now + 5,
      now + 30,
      otherPendingJobId,
      otherGroupId,
      otherGroupId,
      now + 5,
      now + 30,
    );
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      'raw-summary-policy-confirm-implicit',
      now + 40,
      implicitGroupId,
      JSON.stringify({ token: secret }),
      now + 40,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
    ).run(
      'chat-summary-policy-confirm-implicit',
      'raw-summary-policy-confirm-implicit',
      'message-summary-policy-confirm-implicit',
      implicitGroupId,
      implicitGroupId,
      'qq-user-summary-policy-confirm',
      `Synthetic summary policy confirmation password=${secret}`,
      now + 40,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const policyPath = `${API_PREFIX}/group-summary/policy`;
    const confirmPath = `${policyPath}/confirm`;
    const unauthenticated = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': 'x'.repeat(43),
        'X-LetheBot-Scope': 'y'.repeat(43),
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: 'z'.repeat(43),
        targetState: 'enabled',
      }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(previewRead).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const catalogResponse = await fetch(`${origin}${API_PREFIX}/group-summary/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      entries: Array<{ handle: string; expiresAt: number }>;
      truncated: boolean;
    };
    expect(catalog.entries).toHaveLength(4);
    const scopeRegistry = issueScopeHandle.mock.contexts[0] as GovernanceScopeHandleRegistry;
    const findScopeEntry = (
      entries: Array<{ handle: string; expiresAt: number }>,
      targetSessionId: string,
      groupId: string,
    ): { handle: string; expiresAt: number } => {
      const entry = entries.find((candidate) => {
        const scope = scopeRegistry.resolve({
          sessionId: targetSessionId,
          handle: candidate.handle,
          purpose: 'governance.group_summary_policy.status.read',
        });
        return scope?.kind === 'group' && scope.groupId === groupId;
      });
      expect(entry).toBeDefined();
      return entry as { handle: string; expiresAt: number };
    };
    const implicitScope = findScopeEntry(catalog.entries, sessionDigest, implicitGroupId);
    const storedDisabledScope = findScopeEntry(
      catalog.entries,
      sessionDigest,
      storedDisabledGroupId,
    );
    const storedEnabledScope = findScopeEntry(
      catalog.entries,
      sessionDigest,
      storedEnabledGroupId,
    );

    type ChangePreview = {
      action: 'group.summary_policy.change';
      current: {
        state: 'enabled' | 'disabled';
        stored: boolean;
        version: { generation: number | null; updatedAt: string | null };
      };
      expected: {
        state: 'enabled' | 'disabled';
        generation: number;
        durableEffects: string[];
        enforcementConsequences: string[];
      };
      rollback: Record<string, unknown>;
      previewDigest: string;
      previewHandle: string;
      previewExpiresAt: number;
    };
    const issuePreview = async (
      scopeHandle: string,
      targetState: 'enabled' | 'disabled',
    ): Promise<ChangePreview> => {
      const response = await fetch(`${origin}${policyPath}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Cookie: session.cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'X-LetheBot-CSRF': session.csrfToken,
          'X-LetheBot-Scope': scopeHandle,
        },
        body: JSON.stringify({ action: 'change', targetState }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<ChangePreview>;
    };
    const implicitPreview = await issuePreview(implicitScope.handle, 'enabled');
    const storedEnablePreview = await issuePreview(storedDisabledScope.handle, 'enabled');
    const disablePreview = await issuePreview(storedEnabledScope.handle, 'disabled');
    expect(issuePreviewHandle).toHaveBeenCalledTimes(3);
    expect(changePolicy).not.toHaveBeenCalled();

    const confirmationHeaders = (scopeHandle: string) => ({
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-LetheBot-CSRF': session.csrfToken,
      'X-LetheBot-Scope': scopeHandle,
    });
    const confirmationBody = (
      previewHandle: string,
      targetState: 'enabled' | 'disabled',
    ) => ({ confirm: true, previewHandle, targetState });

    const boundaryRequests = await Promise.all([
      fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: {
          ...confirmationHeaders(implicitScope.handle),
          Origin: 'http://127.0.0.1:1',
        },
        body: JSON.stringify(confirmationBody(implicitPreview.previewHandle, 'enabled')),
      }),
      fetch(`${origin}${confirmPath}?target=${implicitGroupId}`, {
        method: 'POST',
        headers: confirmationHeaders(implicitScope.handle),
        body: JSON.stringify(confirmationBody(implicitPreview.previewHandle, 'enabled')),
      }),
      fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Cookie: session.cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'X-LetheBot-Scope': implicitScope.handle,
        },
        body: JSON.stringify(confirmationBody(implicitPreview.previewHandle, 'enabled')),
      }),
      fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: confirmationHeaders(implicitScope.handle),
        body: JSON.stringify({
          ...confirmationBody(implicitPreview.previewHandle, 'enabled'),
          extra: true,
        }),
      }),
      fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Cookie: session.cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'X-LetheBot-CSRF': session.csrfToken,
        },
        body: JSON.stringify(confirmationBody(implicitPreview.previewHandle, 'enabled')),
      }),
    ]);
    expect(boundaryRequests.map((response) => response.status)).toEqual([
      403,
      400,
      403,
      400,
      400,
    ]);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(changePolicy).not.toHaveBeenCalled();

    const unknown = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: confirmationHeaders(implicitScope.handle),
      body: JSON.stringify(confirmationBody('z'.repeat(43), 'enabled')),
    });
    expect(unknown.status).toBe(404);
    expect(changePolicy).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const secondSessionDigest = digestSessionCookie(secondSession.cookie);
    const secondCatalogResponse = await fetch(`${origin}${API_PREFIX}/group-summary/scopes`, {
      headers: { Connection: 'close', Cookie: secondSession.cookie },
    });
    const secondCatalog = await secondCatalogResponse.json() as typeof catalog;
    const secondImplicitScope = findScopeEntry(
      secondCatalog.entries,
      secondSessionDigest,
      implicitGroupId,
    );
    const crossSession = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-LetheBot-CSRF': secondSession.csrfToken,
        'X-LetheBot-Scope': secondImplicitScope.handle,
      },
      body: JSON.stringify(confirmationBody(implicitPreview.previewHandle, 'enabled')),
    });
    expect(crossSession.status).toBe(404);
    expect(changePolicy).not.toHaveBeenCalled();

    const mismatchedTarget = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: confirmationHeaders(storedDisabledScope.handle),
      body: JSON.stringify(confirmationBody(storedEnablePreview.previewHandle, 'disabled')),
    });
    expect(mismatchedTarget.status).toBe(409);
    expect(changePolicy).not.toHaveBeenCalled();
    const currentStoredEnablePreview = await issuePreview(storedDisabledScope.handle, 'enabled');

    const auditCountBefore = db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'`,
    ).pluck().get();
    const confirm = async (
      scopeHandle: string,
      previewHandle: string,
      targetState: 'enabled' | 'disabled',
    ): Promise<{ response: Response; text: string; body: Record<string, unknown> }> => {
      const response = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: confirmationHeaders(scopeHandle),
        body: JSON.stringify(confirmationBody(previewHandle, targetState)),
      });
      const text = await response.text();
      return { response, text, body: JSON.parse(text) as Record<string, unknown> };
    };

    const implicitConfirmation = await confirm(
      implicitScope.handle,
      implicitPreview.previewHandle,
      'enabled',
    );
    expect(implicitConfirmation.response.status).toBe(200);
    expect(implicitConfirmation.body).toEqual({
      action: 'group.summary_policy.change',
      outcome: 'updated',
      current: {
        state: 'enabled',
        stored: true,
        version: {
          generation: 1,
          updatedAt: new Date(now + 41).toISOString(),
        },
        eligibleAfter: new Date(now + 41).toISOString(),
      },
      durableEffects: implicitPreview.expected.durableEffects,
      enforcementConsequences: implicitPreview.expected.enforcementConsequences,
      evidence: {
        auditEvent: 'group.summary_policy_changed',
        generation: 1,
        updatedAt: new Date(now + 41).toISOString(),
        canceledJobCount: 0,
      },
      rollback: implicitPreview.rollback,
    });
    expect(changePolicy).toHaveBeenLastCalledWith({
      groupId: implicitGroupId,
      enabled: true,
      expectedState: 'disabled',
      expectedVersion: {
        source: 'implicit_default',
        generation: null,
        updatedAt: null,
      },
      reasonCode: 'governance_http_group_summary_policy_change_confirmed',
    });

    const storedEnableConfirmation = await confirm(
      storedDisabledScope.handle,
      currentStoredEnablePreview.previewHandle,
      'enabled',
    );
    expect(storedEnableConfirmation.response.status).toBe(200);
    expect(storedEnableConfirmation.body).toEqual({
      action: 'group.summary_policy.change',
      outcome: 'updated',
      current: {
        state: 'enabled',
        stored: true,
        version: {
          generation: 3,
          updatedAt: new Date(now + 21).toISOString(),
        },
        eligibleAfter: new Date(now + 21).toISOString(),
      },
      durableEffects: currentStoredEnablePreview.expected.durableEffects,
      enforcementConsequences: currentStoredEnablePreview.expected.enforcementConsequences,
      evidence: {
        auditEvent: 'group.summary_policy_changed',
        generation: 3,
        updatedAt: new Date(now + 21).toISOString(),
        canceledJobCount: 0,
      },
      rollback: currentStoredEnablePreview.rollback,
    });
    expect(changePolicy).toHaveBeenLastCalledWith({
      groupId: storedDisabledGroupId,
      enabled: true,
      expectedState: 'disabled',
      expectedVersion: {
        source: 'stored_policy',
        generation: 2,
        updatedAt: now + 20,
      },
      reasonCode: 'governance_http_group_summary_policy_change_confirmed',
    });

    const disableConfirmation = await confirm(
      storedEnabledScope.handle,
      disablePreview.previewHandle,
      'disabled',
    );
    expect(disableConfirmation.response.status).toBe(200);
    expect(disableConfirmation.body).toEqual({
      action: 'group.summary_policy.change',
      outcome: 'updated',
      current: {
        state: 'disabled',
        stored: true,
        version: {
          generation: 4,
          updatedAt: new Date(now + 31).toISOString(),
        },
        eligibleAfter: null,
      },
      durableEffects: disablePreview.expected.durableEffects,
      enforcementConsequences: disablePreview.expected.enforcementConsequences,
      evidence: {
        auditEvent: 'group.summary_policy_changed',
        generation: 4,
        updatedAt: new Date(now + 31).toISOString(),
        canceledJobCount: 1,
      },
      rollback: disablePreview.rollback,
    });
    expect(changePolicy).toHaveBeenLastCalledWith({
      groupId: storedEnabledGroupId,
      enabled: false,
      expectedState: 'enabled',
      expectedVersion: {
        source: 'stored_policy',
        generation: 3,
        updatedAt: now + 10,
      },
      reasonCode: 'governance_http_group_summary_policy_change_confirmed',
    });
    expect(changePolicy).toHaveBeenCalledTimes(3);

    const reused = await confirm(
      implicitScope.handle,
      implicitPreview.previewHandle,
      'enabled',
    );
    expect(reused.response.status).toBe(409);
    expect(changePolicy).toHaveBeenCalledTimes(3);

    const driftPreview = await issuePreview(storedDisabledScope.handle, 'disabled');
    db.prepare(
      `UPDATE group_summary_policies SET updated_at = updated_at + 1 WHERE group_id = ?`,
    ).run(storedDisabledGroupId);
    const drifted = await confirm(
      storedDisabledScope.handle,
      driftPreview.previewHandle,
      'disabled',
    );
    expect(drifted.response.status).toBe(409);
    expect(changePolicy).toHaveBeenCalledTimes(3);

    const racePreview = await issuePreview(storedDisabledScope.handle, 'disabled');
    previewRead.mockImplementationOnce(async (input) => {
      const current = await originalPreviewRead.call(new GovernanceQueryService(db), input);
      db.prepare(
        `UPDATE group_summary_policies
            SET generation = generation + 1, updated_at = updated_at + 1
          WHERE group_id = ?`,
      ).run(storedDisabledGroupId);
      return current;
    });
    const raced = await confirm(
      storedDisabledScope.handle,
      racePreview.previewHandle,
      'disabled',
    );
    expect(raced.response.status).toBe(409);
    expect(changePolicy).toHaveBeenCalledTimes(4);
    expect(changePolicy.mock.results.at(-1)?.value).toEqual({ outcome: 'stale' });

    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'`,
    ).pluck().get()).toBe((auditCountBefore as number) + 3);
    expect(db.prepare(
      `SELECT status, error FROM jobs WHERE id = ?`,
    ).get(pendingJobId)).toEqual({
      status: 'failed',
      error: 'group_summary_policy_disabled',
    });
    expect(db.prepare(
      `SELECT canceled_at IS NOT NULL AS canceled,
              cancellation_code AS cancellationCode
         FROM group_summary_job_bindings WHERE job_id = ?`,
    ).get(pendingJobId)).toEqual({
      canceled: 1,
      cancellationCode: 'group_summary_policy_disabled',
    });
    expect(db.prepare(
      `SELECT status, error FROM jobs WHERE id = ?`,
    ).get(otherPendingJobId)).toEqual({ status: 'pending', error: null });
    expect(db.prepare(
      `SELECT canceled_at AS canceledAt, cancellation_code AS cancellationCode
         FROM group_summary_job_bindings WHERE job_id = ?`,
    ).get(otherPendingJobId)).toEqual({ canceledAt: null, cancellationCode: null });
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    for (const rawValue of [
      implicitGroupId,
      storedDisabledGroupId,
      storedEnabledGroupId,
      otherGroupId,
      pendingJobId,
      secret,
      sessionDigest,
      'governance_http_group_summary_policy_change_confirmed',
    ]) {
      expect(implicitConfirmation.text).not.toContain(rawValue);
      expect(storedEnableConfirmation.text).not.toContain(rawValue);
      expect(disableConfirmation.text).not.toContain(rawValue);
    }
  });

  it('issues purpose-isolated Memory-record scope handles only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '956789012';
    const secret = 'memory-http-secret-value';
    const canonicalUserId = `memory-http-user-${platformId}-${secret}`;
    const groupId = `memory-http-group-${platformId}-${secret}`;
    const privateConversationId = `memory-http-private-${platformId}-${secret}`;
    const groupConversationId = `memory-http-conversation-${platformId}-${secret}`;
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listMemoryRecordScopeHandles',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-13T00:00:00.000Z');
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(canonicalUserId, now, now);
    const insertMemory = db.prepare(
      `INSERT INTO memory_records (
         id, scope, canonical_user_id, group_id, conversation_id,
         visibility, sensitivity, authority, kind, title, content, state,
         confidence, importance, source_context, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'owner_admin_only', 'normal', 'system',
                 'fact', 'Synthetic Memory scope', 'Synthetic Memory content', ?,
                 0.5, 0.5, 'synthetic_memory_http_scope', ?, ?)`,
    );
    const scopeRows = [
      ['memory-http-global', 'global', null, null, null, 'active'],
      ['memory-http-user', 'user', canonicalUserId, null, null, 'rejected'],
      ['memory-http-group', 'group', null, groupId, null, 'superseded'],
      [
        'memory-http-private-conversation',
        'conversation',
        null,
        null,
        privateConversationId,
        'disabled',
      ],
      [
        'memory-http-group-conversation',
        'conversation',
        null,
        groupId,
        groupConversationId,
        'deleted',
      ],
      ['memory-http-system', 'system', null, null, null, 'proposed'],
      ['memory-http-tool-omitted', 'tool', null, null, null, 'active'],
    ] as const;
    scopeRows.forEach((row, index) => {
      insertMemory.run(...row, now + index, now + index);
    });
    expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposals').pluck().get()).toBe(0);

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/memory/scopes`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?scope=global`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const catalog = JSON.parse(responseText) as {
      entries: Array<{
        fingerprint: string;
        scopeKind: string;
        conversationType?: string;
        label: string;
        handle: string;
        expiresAt: number;
      }>;
      truncated: boolean;
    };
    expect(catalog).toEqual({
      entries: [
        expect.objectContaining({ scopeKind: 'global', label: 'Global memory' }),
        expect.objectContaining({ scopeKind: 'user', label: 'User memory' }),
        expect.objectContaining({ scopeKind: 'group', label: 'Group memory' }),
        expect.objectContaining({
          scopeKind: 'conversation',
          conversationType: 'private',
          label: 'Private conversation memory',
        }),
        expect.objectContaining({
          scopeKind: 'conversation',
          conversationType: 'group',
          label: 'Group conversation memory',
        }),
        expect.objectContaining({ scopeKind: 'system', label: 'System memory' }),
      ],
      truncated: false,
    });
    expect(catalog.entries.every((entry) => /^[0-9a-f]{16}$/u.test(entry.fingerprint)))
      .toBe(true);
    expect(catalog.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle)))
      .toBe(true);
    expect(catalog.entries.every((entry) => Number.isSafeInteger(entry.expiresAt))).toBe(true);
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(catalogRead).toHaveBeenCalledWith(expect.any(Function));
    expect(issueScopeHandle).toHaveBeenCalledTimes(6);
    expect(issueScopeHandle.mock.calls.slice(0, 6).map(([input]) => input)).toEqual([
      {
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.memory.records.read',
        scope: { kind: 'global' },
      },
      {
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.memory.records.read',
        scope: { kind: 'user', canonicalUserId },
      },
      {
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.memory.records.read',
        scope: { kind: 'group', groupId },
      },
      {
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.memory.records.read',
        scope: {
          kind: 'conversation',
          conversationId: privateConversationId,
          conversationType: 'private',
        },
      },
      {
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.memory.records.read',
        scope: {
          kind: 'conversation',
          conversationId: groupConversationId,
          conversationType: 'group',
          groupId,
        },
      },
      {
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.memory.records.read',
        scope: { kind: 'system' },
      },
    ]);
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      groupId,
      privateConversationId,
      groupConversationId,
      sessionDigest,
      'memory-http-global',
    ]) {
      expect(responseText).not.toContain(rawValue);
    }
    expect(responseText).not.toContain('tool');

    const legacyCatalog = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(legacyCatalog.status).toBe(200);
    expect(await legacyCatalog.json()).toEqual({ entries: [], truncated: false });

    const privacyCatalogResponse = await fetch(`${origin}${API_PREFIX}/privacy/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(privacyCatalogResponse.status).toBe(200);
    const privacyCatalog = await privacyCatalogResponse.json() as {
      entries: Array<{ label: string; handle: string }>;
    };
    expect(privacyCatalog.entries).toEqual([
      expect.objectContaining({ label: 'User privacy' }),
    ]);

    const memoryHandle = catalog.entries[0]?.handle ?? '';
    const maintenanceCrossPurpose = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(maintenanceCrossPurpose.status).toBe(404);
    const privacyCrossPurpose = await fetch(`${origin}${API_PREFIX}/privacy/preferences`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(privacyCrossPurpose.status).toBe(404);
    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(catalogRead).toHaveBeenCalledTimes(2);
    expect(issueScopeHandle).toHaveBeenCalledTimes(13);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues purpose-isolated Explain conversation handles only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '978654321';
    const secret = 'sk-explainhttpabcdefghijklmnopqrstuvwxyz123456';
    const privateConversationId = `explain-http-private-${platformId}-${secret}`;
    const groupConversationId = `explain-http-group-${platformId}-${secret}`;
    const groupId = `explain-http-group-id-${platformId}-${secret}`;
    const catalogRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listExplainConversationScopeHandles',
    );
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-15T00:00:00.000Z');
    const insertRawEvent = db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, context_pack_id,
         pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, 'synthetic-model', 'synthetic-provider', 'completed', ?)`,
    );
    const insertTrace = db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '[]', ?)`,
    );
    const traceScopes = [
      {
        suffix: 'private',
        conversationId: privateConversationId,
        conversationType: 'private',
        groupId: null,
        createdAt: now,
      },
      {
        suffix: 'group',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
        createdAt: now + 1,
      },
    ] as const;
    traceScopes.forEach((scope) => {
      const rawEventId = `raw-explain-http-${scope.suffix}`;
      const turnId = `turn-explain-http-${scope.suffix}`;
      const traceId = `trace-explain-http-${scope.suffix}`;
      insertRawEvent.run(rawEventId, scope.createdAt, scope.conversationId, scope.createdAt);
      insertTurn.run(
        turnId,
        scope.conversationId,
        rawEventId,
        traceId,
        scope.createdAt,
      );
      insertTrace.run(
        traceId,
        turnId,
        scope.conversationId,
        scope.conversationType,
        scope.groupId,
        scope.createdAt,
      );
    });

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/explain/scopes`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const sessionDigest = digestSessionCookie(session.cookie);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?conversation=private`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(issueScopeHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const catalog = JSON.parse(responseText) as {
      entries: Array<{
        fingerprint: string;
        scopeKind: string;
        conversationType: string;
        label: string;
        handle: string;
        expiresAt: number;
      }>;
      truncated: boolean;
    };
    expect(catalog).toEqual({
      entries: [
        {
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
          scopeKind: 'conversation',
          conversationType: 'group',
          label: 'Group conversation',
          handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          expiresAt: expect.any(Number),
        },
        {
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
          scopeKind: 'conversation',
          conversationType: 'private',
          label: 'Private conversation',
          handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          expiresAt: expect.any(Number),
        },
      ],
      truncated: false,
    });
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(catalogRead).toHaveBeenCalledWith(expect.any(Function));
    expect(issueScopeHandle).toHaveBeenCalledTimes(2);
    const expectedScopes = [
      {
        kind: 'conversation',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
      },
      {
        kind: 'conversation',
        conversationId: privateConversationId,
        conversationType: 'private',
      },
    ] as const;
    expect(issueScopeHandle.mock.calls.slice(0, 2).map(([input]) => input)).toEqual(
      expectedScopes.map((scope) => ({
        sessionId: sessionDigest,
        sessionExpiresAt: expect.any(Number),
        purpose: 'governance.explain.turns.read',
        scope,
      })),
    );
    for (const rawValue of [
      platformId,
      secret,
      privateConversationId,
      groupConversationId,
      groupId,
      sessionDigest,
      'trace-explain-http-private',
      'turn-explain-http-private',
    ]) {
      expect(responseText).not.toContain(rawValue);
    }

    const secondSession = await loginGovernance(origin);
    const secondSessionDigest = digestSessionCookie(secondSession.cookie);
    const registry = issueScopeHandle.mock.instances[0];
    catalog.entries.forEach((entry, index) => {
      expect(registry?.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.explain.turns.read',
      })).toEqual(expectedScopes[index]);
      expect(registry?.resolve({
        sessionId: secondSessionDigest,
        handle: entry.handle,
        purpose: 'governance.explain.turns.read',
      })).toBeNull();
      expect(registry?.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.memory.records.read',
      })).toBeNull();
      expect(registry?.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'governance.privacy.preferences.read',
      })).toBeNull();
      expect(registry?.resolve({
        sessionId: sessionDigest,
        handle: entry.handle,
        purpose: 'memory.maintenance.review',
      })).toBeNull();
    });

    const legacyCatalog = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(legacyCatalog.status).toBe(200);
    expect(await legacyCatalog.json()).toEqual({ entries: [], truncated: false });
    const memoryCatalog = await fetch(`${origin}${API_PREFIX}/memory/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(memoryCatalog.status).toBe(200);
    expect(await memoryCatalog.json()).toEqual({ entries: [], truncated: false });
    const privacyCatalog = await fetch(`${origin}${API_PREFIX}/privacy/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(privacyCatalog.status).toBe(200);
    expect(await privacyCatalog.json()).toEqual({ entries: [], truncated: false });
    const explainDataWithoutScope = await fetch(`${origin}${API_PREFIX}/explain/turns`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(explainDataWithoutScope.status).toBe(400);

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(catalogRead).toHaveBeenCalledTimes(2);
    expect(issueScopeHandle).toHaveBeenCalledTimes(4);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves only the exact scoped bounded Explain turn page with resource handles', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '976543210';
    const secret = 'sk-explainturnabcdefghijklmnopqrstuvwxyz123456';
    const privateConversationId = `explain-turn-private-${platformId}-${secret}`;
    const groupConversationId = `explain-turn-group-${platformId}-${secret}`;
    const groupId = `explain-turn-group-id-${platformId}-${secret}`;
    const privateTurnId = `turn-explain-page-private-${platformId}-${secret}`;
    const groupTurnId = `turn-explain-page-group-${platformId}-${secret}`;
    const privateTraceId = `trace-explain-page-private-${platformId}-${secret}`;
    const groupTraceId = `trace-explain-page-group-${platformId}-${secret}`;
    const turnResourcePageRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listExplainTurnResourceHandlePage',
    );
    const legacyTurnPageRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listExplainTurnsForScope',
    );
    const storedContextRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'explainStoredContext',
    );
    const turnResolutionRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'resolveExplainTurn',
    );
    const toolRead = vi.spyOn(GovernanceQueryService.prototype, 'explainToolCalls');
    const actionDecisionRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'explainActionDecision',
    );
    const actionExecutionRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'explainActionExecutions',
    );
    const explainTurnDetailRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getExplainTurnDetailForScope',
    );
    const resolveScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'resolve');
    const issueScopeHandle = vi.spyOn(GovernanceScopeHandleRegistry.prototype, 'issue');
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-16T00:00:00.000Z');
    const insertRawEvent = db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, context_pack_id,
         pi_model, pi_provider, status, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTrace = db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '[]', ?)`,
    );
    const fixtures = [{
      conversationId: privateConversationId,
      conversationType: 'private',
      groupId: null,
      turnId: privateTurnId,
      traceId: privateTraceId,
      status: 'completed',
      startedAt: now,
      completedAt: now + 25,
    }, {
      conversationId: groupConversationId,
      conversationType: 'group',
      groupId,
      turnId: groupTurnId,
      traceId: groupTraceId,
      status: 'running',
      startedAt: now + 100,
      completedAt: null,
    }] as const;
    fixtures.forEach((fixture) => {
      const rawEventId = `raw-${fixture.turnId}`;
      insertRawEvent.run(
        rawEventId,
        fixture.startedAt,
        fixture.conversationId,
        fixture.startedAt,
      );
      insertTurn.run(
        fixture.turnId,
        fixture.conversationId,
        rawEventId,
        fixture.traceId,
        `model-${platformId}-${secret}`,
        `provider-${platformId}-${secret}`,
        fixture.status,
        fixture.startedAt,
        fixture.completedAt,
      );
      insertTrace.run(
        fixture.traceId,
        fixture.turnId,
        fixture.conversationId,
        fixture.conversationType,
        fixture.groupId,
        fixture.startedAt,
      );
    });

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/explain/turns`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const catalogResponse = await fetch(`${origin}${API_PREFIX}/explain/scopes`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      entries: Array<{
        conversationType: 'private' | 'group';
        handle: string;
        expiresAt: number;
      }>;
    };
    expect(catalog.entries).toHaveLength(2);
    const privateEntry = catalog.entries.find((entry) => entry.conversationType === 'private');
    const groupEntry = catalog.entries.find((entry) => entry.conversationType === 'group');
    expect(privateEntry?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(groupEntry?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const privateHandle = privateEntry?.handle ?? '';
    const groupHandle = groupEntry?.handle ?? '';
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();

    const missingScope = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingScope.status).toBe(400);
    expect(await missingScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const malformedScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedScope.status).toBe(400);
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const withQuery = await fetch(`${origin}${path}?status=completed`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privateHandle,
      },
    });
    expect(withQuery.status).toBe(400);
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownScope.status).toBe(404);
    expect(await unknownScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const crossSession = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(crossSession.status).toBe(404);
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const registry = issueScopeHandle.mock.instances[0];
    const crossPurposeHandle = registry?.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: groupEntry?.expiresAt ?? 0,
      purpose: 'governance.memory.records.read',
      scope: {
        kind: 'conversation',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
      },
    }).handle ?? '';
    const crossPurpose = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': crossPurposeHandle,
      },
    });
    expect(crossPurpose.status).toBe(404);
    expect(turnResourcePageRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const reference = (value: string) => createHash('sha256')
      .update('lethebot-governance:explain-turn:v1\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const groupResponse = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(groupResponse.status).toBe(200);
    const groupResponseText = await groupResponse.text();
    expect(turnResourcePageRead).toHaveBeenNthCalledWith(1, {
      kind: 'conversation',
      conversationId: groupConversationId,
      conversationType: 'group',
      groupId,
    }, expect.any(Function));
    expect(legacyTurnPageRead).not.toHaveBeenCalled();
    const groupResponseBody = JSON.parse(groupResponseText) as {
      entries: Array<{ handle: string; handleExpiresAt: number }>;
      truncated: boolean;
    };
    expect(groupResponseBody).toEqual({
      entries: [{
        fingerprint: reference(groupTurnId),
        label: 'Turn',
        traceSource: 'stored',
        status: 'running',
        startedAt: new Date(now + 100).toISOString(),
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        handleExpiresAt: groupEntry?.expiresAt,
      }],
      truncated: false,
    });
    const groupResourceHandle = groupResponseBody.entries[0]?.handle ?? '';
    expect(issueResourceHandle).toHaveBeenNthCalledWith(1, {
      sessionId: firstSessionDigest,
      sessionExpiresAt: groupEntry?.expiresAt,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      resourceId: groupTurnId,
      scope: {
        kind: 'conversation',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
      },
    });

    const privateResponse = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privateHandle,
      },
    });
    expect(privateResponse.status).toBe(200);
    const privateResponseText = await privateResponse.text();
    expect(turnResourcePageRead).toHaveBeenNthCalledWith(2, {
      kind: 'conversation',
      conversationId: privateConversationId,
      conversationType: 'private',
    }, expect.any(Function));
    const privateResponseBody = JSON.parse(privateResponseText) as {
      entries: Array<{ handle: string; handleExpiresAt: number }>;
      truncated: boolean;
    };
    expect(privateResponseBody).toEqual({
      entries: [{
        fingerprint: reference(privateTurnId),
        label: 'Turn',
        traceSource: 'stored',
        status: 'completed',
        startedAt: new Date(now).toISOString(),
        completedAt: new Date(now + 25).toISOString(),
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        handleExpiresAt: privateEntry?.expiresAt,
      }],
      truncated: false,
    });
    const privateResourceHandle = privateResponseBody.entries[0]?.handle ?? '';
    expect(issueResourceHandle).toHaveBeenNthCalledWith(2, {
      sessionId: firstSessionDigest,
      sessionExpiresAt: privateEntry?.expiresAt,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      resourceId: privateTurnId,
      scope: {
        kind: 'conversation',
        conversationId: privateConversationId,
        conversationType: 'private',
      },
    });
    const resourceRegistry = issueResourceHandle.mock.contexts[0] as
      GovernanceResourceHandleRegistry;
    const groupScope = {
      kind: 'conversation',
      conversationId: groupConversationId,
      conversationType: 'group',
      groupId,
    } as const;
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: groupResourceHandle,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      scope: groupScope,
    })).toEqual({ kind: 'explain_turn', resourceId: groupTurnId });
    expect(resourceRegistry.resolve({
      sessionId: digestSessionCookie(secondSession.cookie),
      handle: groupResourceHandle,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      scope: groupScope,
    })).toBeNull();
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: groupResourceHandle,
      purpose: 'governance.memory.records.read',
      resourceKind: 'explain_turn',
      scope: groupScope,
    })).toBeNull();
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: groupResourceHandle,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'memory_record',
      scope: groupScope,
    })).toBeNull();
    expect(resourceRegistry.resolve({
      sessionId: firstSessionDigest,
      handle: groupResourceHandle,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      scope: {
        kind: 'conversation',
        conversationId: privateConversationId,
        conversationType: 'private',
      },
    })).toBeNull();
    expect(privateResourceHandle).not.toBe(groupResourceHandle);
    for (const rawValue of [
      platformId,
      secret,
      privateConversationId,
      groupConversationId,
      groupId,
      privateTurnId,
      groupTurnId,
      privateTraceId,
      groupTraceId,
      firstSessionDigest,
      `model-${platformId}-${secret}`,
      `provider-${platformId}-${secret}`,
    ]) {
      expect(groupResponseText).not.toContain(rawValue);
      expect(privateResponseText).not.toContain(rawValue);
    }

    const repeated = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(groupResponseText);
    expect(turnResourcePageRead).toHaveBeenCalledTimes(3);
    expect(issueResourceHandle).toHaveBeenCalledTimes(3);
    expect(legacyTurnPageRead).not.toHaveBeenCalled();

    const resourceResolutionCount = resolveResourceHandle.mock.calls.length;
    const groupDetailPath = `${path}/${groupResourceHandle}`;
    const privateDetailPath = `${path}/${privateResourceHandle}`;
    const unauthenticatedDetail = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(unauthenticatedDetail.status).toBe(401);
    expect(await unauthenticatedDetail.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const missingDetailScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingDetailScope.status).toBe(400);
    expect(await missingDetailScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const malformedDetailScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedDetailScope.status).toBe(400);
    expect(await malformedDetailScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const missingDetailHandle = await fetch(`${origin}${path}/`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(missingDetailHandle.status).toBe(400);
    expect(await missingDetailHandle.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const malformedDetailHandle = await fetch(`${origin}${path}/malformed`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(malformedDetailHandle.status).toBe(400);
    expect(await malformedDetailHandle.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const queriedDetail = await fetch(`${origin}${groupDetailPath}?include=raw`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(queriedDetail.status).toBe(400);
    expect(await queriedDetail.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const unknownDetailScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownDetailScope.status).toBe(404);
    expect(await unknownDetailScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const crossPurposeDetailScope = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': crossPurposeHandle,
      },
    });
    expect(crossPurposeDetailScope.status).toBe(404);
    expect(await crossPurposeDetailScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const unknownDetail = await fetch(`${origin}${path}/${'y'.repeat(43)}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(unknownDetail.status).toBe(404);
    expect(await unknownDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 1);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const scopeRegistry = issueScopeHandle.mock.contexts[0] as
      GovernanceScopeHandleRegistry;
    const secondGroupHandle = scopeRegistry.issue({
      sessionId: digestSessionCookie(secondSession.cookie),
      sessionExpiresAt: groupEntry?.expiresAt ?? 0,
      purpose: 'governance.explain.turns.read',
      scope: groupScope,
    }).handle;
    const crossSessionDetail = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': secondGroupHandle,
      },
    });
    expect(crossSessionDetail.status).toBe(404);
    expect(await crossSessionDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 2);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const crossPurposeResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: groupEntry?.expiresAt ?? 0,
      purpose: 'governance.memory.records.read',
      resourceKind: 'explain_turn',
      resourceId: groupTurnId,
      scope: groupScope,
    });
    const crossPurposeDetail = await fetch(`${origin}${path}/${crossPurposeResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(crossPurposeDetail.status).toBe(404);
    expect(await crossPurposeDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 3);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const crossKindResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: groupEntry?.expiresAt ?? 0,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'memory_record',
      resourceId: groupTurnId,
      scope: groupScope,
    });
    const crossKindDetail = await fetch(`${origin}${path}/${crossKindResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(crossKindDetail.status).toBe(404);
    expect(await crossKindDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 4);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const crossScopeDetail = await fetch(`${origin}${privateDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(crossScopeDetail.status).toBe(404);
    expect(await crossScopeDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 5);
    expect(explainTurnDetailRead).not.toHaveBeenCalled();

    const missingTurnId = 'turn-explain-page-missing';
    const missingResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: groupEntry?.expiresAt ?? 0,
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      resourceId: missingTurnId,
      scope: groupScope,
    });
    const missingDetail = await fetch(`${origin}${path}/${missingResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(missingDetail.status).toBe(404);
    expect(await missingDetail.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(explainTurnDetailRead).toHaveBeenCalledTimes(1);
    expect(explainTurnDetailRead).toHaveBeenLastCalledWith({
      scope: groupScope,
      turnId: missingTurnId,
    });

    const groupDetail = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(groupDetail.status).toBe(200);
    const groupDetailText = await groupDetail.text();
    expect(JSON.parse(groupDetailText)).toEqual({
      turn: {
        fingerprint: reference(groupTurnId),
        label: 'Turn',
        traceSource: 'stored',
        status: 'running',
        startedAt: new Date(now + 100).toISOString(),
      },
      context: {
        traceSource: 'stored',
        candidateMemoryCount: 0,
        selectedMemoryCount: 0,
        rejectedMemoryCount: 0,
        recentMessageCount: 0,
        includedMemoryCount: 0,
        filters: [],
        filtersTruncated: false,
        injectedIdentityFields: [],
        injectedIdentityFieldsTruncated: false,
      },
      tools: [],
      toolsTruncated: false,
    });
    expect(explainTurnDetailRead).toHaveBeenCalledTimes(2);
    expect(explainTurnDetailRead).toHaveBeenLastCalledWith({
      scope: groupScope,
      turnId: groupTurnId,
    });

    const privateScope = {
      kind: 'conversation',
      conversationId: privateConversationId,
      conversationType: 'private',
    } as const;
    const privateDetail = await fetch(`${origin}${privateDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privateHandle,
      },
    });
    expect(privateDetail.status).toBe(200);
    const privateDetailText = await privateDetail.text();
    expect(JSON.parse(privateDetailText)).toEqual({
      turn: {
        fingerprint: reference(privateTurnId),
        label: 'Turn',
        traceSource: 'stored',
        status: 'completed',
        startedAt: new Date(now).toISOString(),
        completedAt: new Date(now + 25).toISOString(),
      },
      context: {
        traceSource: 'stored',
        candidateMemoryCount: 0,
        selectedMemoryCount: 0,
        rejectedMemoryCount: 0,
        recentMessageCount: 0,
        includedMemoryCount: 0,
        filters: [],
        filtersTruncated: false,
        injectedIdentityFields: [],
        injectedIdentityFieldsTruncated: false,
      },
      tools: [],
      toolsTruncated: false,
    });
    expect(explainTurnDetailRead).toHaveBeenCalledTimes(3);
    expect(explainTurnDetailRead).toHaveBeenLastCalledWith({
      scope: privateScope,
      turnId: privateTurnId,
    });

    const repeatedDetail = await fetch(`${origin}${groupDetailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(repeatedDetail.status).toBe(200);
    expect(await repeatedDetail.text()).toBe(groupDetailText);
    expect(explainTurnDetailRead).toHaveBeenCalledTimes(4);
    for (const detailText of [groupDetailText, privateDetailText]) {
      for (const rawValue of [
        platformId,
        secret,
        privateConversationId,
        groupConversationId,
        groupId,
        privateTurnId,
        groupTurnId,
        privateTraceId,
        groupTraceId,
        firstSessionDigest,
        groupResourceHandle,
        privateResourceHandle,
        `model-${platformId}-${secret}`,
        `provider-${platformId}-${secret}`,
      ]) {
        expect(detailText).not.toContain(rawValue);
      }
    }

    const detailMutation = await fetch(`${origin}${groupDetailPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(detailMutation.status).toBe(404);
    const listMutation = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': groupHandle,
      },
    });
    expect(listMutation.status).toBe(404);
    expect(turnResourcePageRead).toHaveBeenCalledTimes(3);
    expect(issueResourceHandle).toHaveBeenCalledTimes(6);
    expect(resolveResourceHandle).toHaveBeenCalledTimes(resourceResolutionCount + 9);
    expect(explainTurnDetailRead).toHaveBeenCalledTimes(4);
    expect(legacyTurnPageRead).not.toHaveBeenCalled();
    expect(storedContextRead).not.toHaveBeenCalled();
    expect(turnResolutionRead).not.toHaveBeenCalled();
    expect(toolRead).not.toHaveBeenCalled();
    expect(actionDecisionRead).not.toHaveBeenCalled();
    expect(actionExecutionRead).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves only the exact scoped bounded Memory-record page and provenance detail', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '934567890';
    const secret = 'sk-memoryhttpabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `memory-http-page-user-${platformId}-${secret}`;
    const visibleMemoryId = `memory-http-page-visible-${platformId}-${secret}`;
    const restrictedMemoryId = `memory-http-page-restricted-${platformId}-${secret}`;
    const visibleSourceId = `memory-http-source-${platformId}-${secret}`;
    const visibleRevisionId = `memory-http-revision-${platformId}-${secret}`;
    const memoryResourceRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listMemoryRecordResourceHandlePage',
    );
    const legacyMemoryRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listMemoryRecordsForScope',
    );
    const resolveScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'resolve',
    );
    const issueResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'issue',
    );
    const resolveResourceHandle = vi.spyOn(
      GovernanceResourceHandleRegistry.prototype,
      'resolve',
    );
    const memoryDetailRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getMemoryRecordDetailForScope',
    );
    const memoryForgetPreviewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getMemoryRecordForgetPreviewForScope',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const forgetMemory = vi.spyOn(
      GovernanceService.prototype,
      'forgetMemoryAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-14T00:00:00.000Z');
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(canonicalUserId, now, now);
    const insertMemory = db.prepare(
      `INSERT INTO memory_records (
         id, scope, canonical_user_id, subject_user_id,
         visibility, sensitivity, authority, kind, title, content, state,
         confidence, importance, source_context, evaluator_decision_id,
         created_at, updated_at, expires_at
       ) VALUES (?, 'user', ?, ?, 'owner_admin_only', ?, 'system', 'fact',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMemory.run(
      visibleMemoryId,
      canonicalUserId,
      `memory-http-subject-${platformId}-${secret}`,
      'normal',
      `Memory ${platformId}`,
      `api_key=${secret}`,
      'active',
      0.7,
      0.9,
      `memory_http_source_context_${platformId}_${secret}`,
      `memory-http-evaluator-${platformId}-${secret}`,
      now + 1,
      now + 2,
      now + 10_000,
    );
    insertMemory.run(
      restrictedMemoryId,
      canonicalUserId,
      null,
      'secret',
      `Restricted ${platformId} ${secret}`,
      `Restricted content ${platformId} ${secret}`,
      'disabled',
      0.4,
      0.8,
      'memory_http_restricted_source_context',
      null,
      now,
      now,
      null,
    );
    db.prepare(
      `INSERT INTO memory_sources (
         memory_id, source_type, source_id, source_timestamp, extracted_by,
         resolution_state
       ) VALUES (?, 'user_command', ?, ?, 'user', 'external')`,
    ).run(visibleMemoryId, visibleSourceId, now);
    db.prepare(
      `INSERT INTO memory_revisions (
         id, memory_id, revision_number, change_type, previous_state, new_state,
         reason, actor, evaluator_decision_id, created_at
       ) VALUES (?, ?, 1, 'update', '{}', '{}', ?, ?, ?, ?)`,
    ).run(
      visibleRevisionId,
      visibleMemoryId,
      `memory-http-reason-${platformId}-${secret}`,
      `memory-http-actor-${platformId}-${secret}`,
      `memory-http-revision-evaluator-${platformId}-${secret}`,
      now,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/memory/records`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const catalogResponse = await fetch(`${origin}${API_PREFIX}/memory/scopes`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      entries: Array<{ scopeKind: string; handle: string }>;
    };
    expect(catalog.entries).toHaveLength(1);
    const memoryHandle = catalog.entries[0]?.handle ?? '';
    expect(memoryHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();

    const missingScope = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingScope.status).toBe(400);
    expect(await missingScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const malformedScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedScope.status).toBe(400);
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const withQuery = await fetch(`${origin}${path}?state=active`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(withQuery.status).toBe(400);
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownScope.status).toBe(404);
    expect(await unknownScope.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const crossSession = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(crossSession.status).toBe(404);
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const privacyCatalogResponse = await fetch(`${origin}${API_PREFIX}/privacy/scopes`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(privacyCatalogResponse.status).toBe(200);
    const privacyCatalog = await privacyCatalogResponse.json() as {
      entries: Array<{ handle: string }>;
    };
    const privacyHandle = privacyCatalog.entries[0]?.handle ?? '';
    const crossPurpose = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(crossPurpose.status).toBe(404);
    expect(memoryResourceRead).not.toHaveBeenCalled();
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(memoryResourceRead).toHaveBeenCalledTimes(1);
    expect(memoryResourceRead).toHaveBeenCalledWith({
      kind: 'user',
      canonicalUserId,
    }, expect.any(Function));
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    const reference = (purpose: string, value: string) => createHash('sha256')
      .update(`lethebot-governance:${purpose}:v1\0`, 'utf8')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const recordRef = (id: string) => reference('memory', id);
    const responseBody = JSON.parse(responseText) as {
      entries: Array<{ handle: string; handleExpiresAt: number }>;
      truncated: boolean;
    };
    expect(responseBody).toEqual({
      entries: [{
        recordRef: recordRef(visibleMemoryId),
        scopeKind: 'user',
        visibility: 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: 'Memory [REDACTED:platform_id]',
        contentPreview: '[REDACTED:api_key_assignment]',
        state: 'active',
        confidence: 0.7,
        importance: 0.9,
        sourceCount: 1,
        revisionCount: 1,
        createdAt: new Date(now + 1).toISOString(),
        updatedAt: new Date(now + 2).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
        textHidden: false,
        titleRedacted: true,
        titleTruncated: false,
        contentRedacted: true,
        contentTruncated: false,
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        handleExpiresAt: expect.any(Number),
      }, {
        recordRef: recordRef(restrictedMemoryId),
        scopeKind: 'user',
        visibility: 'owner_admin_only',
        sensitivity: 'secret',
        authority: 'system',
        kind: 'fact',
        title: '[REDACTED:restricted_memory]',
        contentPreview: '[REDACTED:restricted_memory]',
        state: 'disabled',
        confidence: 0.4,
        importance: 0.8,
        sourceCount: 0,
        revisionCount: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        textHidden: true,
        titleRedacted: true,
        titleTruncated: false,
        contentRedacted: true,
        contentTruncated: false,
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        handleExpiresAt: expect.any(Number),
      }],
      truncated: false,
    });
    const visibleResource = responseBody.entries[0];
    const restrictedResource = responseBody.entries[1];
    expect(visibleResource?.handle).not.toBe(restrictedResource?.handle);
    expect(Number.isSafeInteger(visibleResource?.handleExpiresAt)).toBe(true);
    expect(restrictedResource?.handleExpiresAt).toBe(visibleResource?.handleExpiresAt);
    expect(issueResourceHandle).toHaveBeenCalledTimes(2);
    expect(issueResourceHandle).toHaveBeenNthCalledWith(1, {
      sessionId: firstSessionDigest,
      sessionExpiresAt: visibleResource?.handleExpiresAt,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_record',
      resourceId: visibleMemoryId,
      scope: { kind: 'user', canonicalUserId },
    });
    expect(issueResourceHandle).toHaveBeenNthCalledWith(2, {
      sessionId: firstSessionDigest,
      sessionExpiresAt: restrictedResource?.handleExpiresAt,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_record',
      resourceId: restrictedMemoryId,
      scope: { kind: 'user', canonicalUserId },
    });
    expect(resolveScopeHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      handle: memoryHandle,
      purpose: 'governance.memory.records.read',
    });
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      visibleMemoryId,
      restrictedMemoryId,
      'memory-http-subject',
      'memory-http-source',
      'memory-http-revision',
      'memory-http-evaluator',
      'memory_http_source_context',
      firstSessionDigest,
    ]) {
      expect(responseText).not.toContain(rawValue);
    }

    const detailPath = `${path}/${visibleResource?.handle ?? ''}`;
    const unauthenticatedDetail = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(unauthenticatedDetail.status).toBe(401);
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const missingDetailScope = await fetch(`${origin}${detailPath}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingDetailScope.status).toBe(400);
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const malformedDetail = await fetch(`${origin}${path}/malformed`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(malformedDetail.status).toBe(400);
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const queriedDetail = await fetch(`${origin}${detailPath}?include=raw`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(queriedDetail.status).toBe(400);
    expect(resolveResourceHandle).not.toHaveBeenCalled();
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const unknownDetail = await fetch(`${origin}${path}/${'z'.repeat(43)}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(unknownDetail.status).toBe(404);
    expect(resolveResourceHandle).toHaveBeenCalledTimes(1);
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const secondCatalogResponse = await fetch(`${origin}${API_PREFIX}/memory/scopes`, {
      headers: { Connection: 'close', Cookie: secondSession.cookie },
    });
    expect(secondCatalogResponse.status).toBe(200);
    const secondCatalog = await secondCatalogResponse.json() as {
      entries: Array<{ handle: string }>;
    };
    const secondMemoryHandle = secondCatalog.entries[0]?.handle ?? '';
    const crossSessionDetail = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': secondMemoryHandle,
      },
    });
    expect(crossSessionDetail.status).toBe(404);
    expect(resolveResourceHandle).toHaveBeenCalledTimes(2);
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const crossPurposeDetail = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(crossPurposeDetail.status).toBe(404);
    expect(resolveResourceHandle).toHaveBeenCalledTimes(2);
    expect(memoryDetailRead).not.toHaveBeenCalled();

    const resourceRegistry = issueResourceHandle.mock.contexts[0] as
      GovernanceResourceHandleRegistry;
    const missingMemoryId = 'memory-http-page-missing';
    const missingResource = resourceRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: visibleResource?.handleExpiresAt ?? 0,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_record',
      resourceId: missingMemoryId,
      scope: { kind: 'user', canonicalUserId },
    });
    const missingDetail = await fetch(`${origin}${path}/${missingResource.handle}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(missingDetail.status).toBe(404);
    expect(memoryDetailRead).toHaveBeenCalledTimes(1);
    expect(memoryDetailRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId },
      memoryId: missingMemoryId,
    });

    const detail = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(JSON.parse(detailText)).toEqual({
      record: {
        recordRef: recordRef(visibleMemoryId),
        scopeKind: 'user',
        visibility: 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: 'Memory [REDACTED:platform_id]',
        contentPreview: '[REDACTED:api_key_assignment]',
        state: 'active',
        confidence: 0.7,
        importance: 0.9,
        sourceCount: 1,
        revisionCount: 1,
        createdAt: new Date(now + 1).toISOString(),
        updatedAt: new Date(now + 2).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
        textHidden: false,
        titleRedacted: true,
        titleTruncated: false,
        contentRedacted: true,
        contentTruncated: false,
      },
      sources: [{
        sourceRef: reference('memory-source', `${visibleMemoryId}\0${visibleSourceId}`),
        sourceType: 'user_command',
        resolutionState: 'external',
        extractorClass: 'user',
        sourceTimestamp: new Date(now).toISOString(),
      }],
      sourcesTruncated: false,
      revisions: [{
        revisionRef: reference('memory-revision', visibleRevisionId),
        revisionNumber: 1,
        changeType: 'update',
        actorClass: 'other',
        reason: expect.stringContaining('[REDACTED:platform_id]'),
        reasonRedacted: true,
        reasonTruncated: false,
        evaluatorLinked: true,
        createdAt: new Date(now).toISOString(),
      }],
      revisionsTruncated: false,
      audit: [],
      auditTruncated: false,
    });
    expect(memoryResourceRead).toHaveBeenCalledTimes(1);
    expect(memoryDetailRead).toHaveBeenCalledTimes(2);
    expect(memoryDetailRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId },
      memoryId: visibleMemoryId,
    });
    expect(resolveResourceHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      handle: visibleResource?.handle,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_record',
      scope: { kind: 'user', canonicalUserId },
    });

    const restrictedDetail = await fetch(
      `${origin}${path}/${restrictedResource?.handle ?? ''}`,
      {
        headers: {
          Connection: 'close',
          Cookie: firstSession.cookie,
          'X-LetheBot-Scope': memoryHandle,
        },
      },
    );
    expect(restrictedDetail.status).toBe(200);
    const restrictedDetailText = await restrictedDetail.text();
    expect(JSON.parse(restrictedDetailText)).toMatchObject({
      record: {
        recordRef: recordRef(restrictedMemoryId),
        title: '[REDACTED:restricted_memory]',
        contentPreview: '[REDACTED:restricted_memory]',
        textHidden: true,
      },
      sources: [],
      sourcesTruncated: false,
      revisions: [],
      revisionsTruncated: false,
      audit: [],
      auditTruncated: false,
    });

    const repeatedDetail = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(repeatedDetail.status).toBe(200);
    expect(await repeatedDetail.text()).toBe(detailText);
    expect(memoryDetailRead).toHaveBeenCalledTimes(4);
    for (const detailOutput of [detailText, restrictedDetailText]) {
      expect(detailOutput).not.toContain(visibleResource?.handle ?? '');
      expect(detailOutput).not.toContain(restrictedResource?.handle ?? '');
      expect(detailOutput).not.toContain(firstSessionDigest);
      for (const rawValue of [
        platformId,
        secret,
        canonicalUserId,
        visibleMemoryId,
        restrictedMemoryId,
        visibleSourceId,
        visibleRevisionId,
        'memory-http-evaluator',
        'memory_http_source_context',
      ]) {
        expect(detailOutput).not.toContain(rawValue);
      }
    }

    const previewHeaders = {
      Connection: 'close',
      Cookie: firstSession.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': firstSession.csrfToken,
      'X-LetheBot-Scope': memoryHandle,
      'Content-Type': 'application/json',
    };
    const unauthenticatedPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(unauthenticatedPreview.status).toBe(401);
    expect(memoryForgetPreviewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(forgetMemory).not.toHaveBeenCalled();

    const missingCsrfPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': '',
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(missingCsrfPreview.status).toBe(403);
    const wrongOriginPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        Origin: 'http://127.0.0.1:1',
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(wrongOriginPreview.status).toBe(403);
    const crossSessionCsrfPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': secondSession.csrfToken,
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(crossSessionCsrfPreview.status).toBe(403);
    const missingScopePreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': '',
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(missingScopePreview.status).toBe(400);
    const malformedResourcePreview = await fetch(`${origin}${path}/malformed`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(malformedResourcePreview.status).toBe(400);
    const queriedPreview = await fetch(`${origin}${detailPath}?confirm=true`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(queriedPreview.status).toBe(400);
    const unknownResourcePreview = await fetch(`${origin}${path}/${'z'.repeat(43)}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(unknownResourcePreview.status).toBe(404);
    const crossSessionPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        Cookie: secondSession.cookie,
        'X-LetheBot-CSRF': secondSession.csrfToken,
        'X-LetheBot-Scope': secondMemoryHandle,
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(crossSessionPreview.status).toBe(404);
    const crossPurposePreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': privacyHandle,
      },
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(crossPurposePreview.status).toBe(404);
    for (const body of [
      null,
      [],
      {},
      { action: 'delete' },
      { action: 'forget', memoryId: visibleMemoryId },
    ]) {
      const invalidBodyPreview = await fetch(`${origin}${detailPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBodyPreview.status).toBe(400);
      expect(await invalidBodyPreview.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    const invalidJsonPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: '{',
    });
    expect(invalidJsonPreview.status).toBe(400);
    expect(memoryForgetPreviewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(forgetMemory).not.toHaveBeenCalled();

    const missingRecordPreview = await fetch(
      `${origin}${path}/${missingResource.handle}`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ action: 'forget' }),
      },
    );
    expect(missingRecordPreview.status).toBe(404);
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(1);
    expect(memoryForgetPreviewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId },
      memoryId: missingMemoryId,
    });
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    const revisionlessPreview = await fetch(
      `${origin}${path}/${restrictedResource?.handle ?? ''}`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ action: 'forget' }),
      },
    );
    expect(revisionlessPreview.status).toBe(404);
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(2);
    expect(memoryForgetPreviewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId },
      memoryId: restrictedMemoryId,
    });
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    const previewResponse = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(previewResponse.status).toBe(201);
    const previewText = await previewResponse.text();
    const previewBody = JSON.parse(previewText) as {
      action: string;
      recordRef: string;
      scopeKind: string;
      current: { lifecycleState: string; revisionNumber: number };
      expected: Record<string, unknown>;
      rollback: Record<string, unknown>;
      previewDigest: string;
      previewHandle: string;
      previewExpiresAt: number;
    };
    expect(previewBody).toEqual({
      action: 'memory.record.forget',
      recordRef: reference('memory-record-forget', visibleMemoryId),
      scopeKind: 'user',
      current: {
        lifecycleState: 'active',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'deleted',
        revisionNumber: 2,
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
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: expect.any(Number),
    });
    expect(Number.isSafeInteger(previewBody.previewExpiresAt)).toBe(true);
    expect(previewBody.previewExpiresAt).toBeLessThanOrEqual(
      visibleResource?.handleExpiresAt ?? 0,
    );
    expect(Object.keys(previewBody).sort()).toEqual([
      'action',
      'current',
      'expected',
      'previewDigest',
      'previewExpiresAt',
      'previewHandle',
      'recordRef',
      'rollback',
      'scopeKind',
    ]);
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(3);
    expect(memoryForgetPreviewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId },
      memoryId: visibleMemoryId,
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(1);
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt: visibleResource?.handleExpiresAt,
      actor: { kind: 'local_admin' },
      action: 'memory.record.forget',
      resourceKind: 'memory_record',
      resourceId: visibleMemoryId,
      scope: { kind: 'user', canonicalUserId },
      expectedState: 'active',
      expectedRevisionNumber: 1,
      previewDigest: previewBody.previewDigest,
    });
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      visibleMemoryId,
      restrictedMemoryId,
      visibleSourceId,
      visibleRevisionId,
      firstSessionDigest,
      visibleResource?.handle ?? '',
      'memory-http-subject',
      'Memory [REDACTED:platform_id]',
      'memory_http_source_context',
      'memory-http-evaluator',
    ]) {
      expect(previewText).not.toContain(rawValue);
    }

    const repeatedPreviewResponse = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'forget' }),
    });
    expect(repeatedPreviewResponse.status).toBe(201);
    const repeatedPreview = await repeatedPreviewResponse.json() as typeof previewBody;
    expect(repeatedPreview.previewDigest).toBe(previewBody.previewDigest);
    expect(repeatedPreview.previewHandle).not.toBe(previewBody.previewHandle);
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(4);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(2);

    const issueAdditionalPreview = async (): Promise<typeof previewBody> => {
      const preview = await fetch(`${origin}${detailPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ action: 'forget' }),
      });
      expect(preview.status).toBe(201);
      return preview.json() as Promise<typeof previewBody>;
    };
    const staleServicePreview = await issueAdditionalPreview();
    const notFoundServicePreview = await issueAdditionalPreview();
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(6);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(4);

    const repeated = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': memoryHandle,
      },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(memoryResourceRead).toHaveBeenCalledTimes(2);
    expect(legacyMemoryRead).not.toHaveBeenCalled();
    expect(issueResourceHandle).toHaveBeenCalledTimes(5);
    expect(memoryDetailRead).toHaveBeenCalledTimes(4);
    expect((await new MemoryRepository(db).retrieve({
      canonicalUserId,
    })).map((memory) => memory.id)).toContain(visibleMemoryId);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);

    const confirmPath = `${detailPath}/confirm`;
    const unauthenticatedConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(unauthenticatedConfirmation.status).toBe(401);
    const missingCsrfConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': '',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(missingCsrfConfirmation.status).toBe(403);
    const wrongOriginConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        Origin: 'http://127.0.0.1:1',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(wrongOriginConfirmation.status).toBe(403);
    const crossSessionCsrfConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': secondSession.csrfToken,
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(crossSessionCsrfConfirmation.status).toBe(403);
    const queriedConfirmation = await fetch(`${origin}${confirmPath}?force=true`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(queriedConfirmation.status).toBe(400);
    const missingScopeConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': '',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(missingScopeConfirmation.status).toBe(400);
    const malformedResourceConfirmation = await fetch(
      `${origin}${path}/malformed/confirm`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
        }),
      },
    );
    expect(malformedResourceConfirmation.status).toBe(400);
    const unknownResourceConfirmation = await fetch(
      `${origin}${path}/${'z'.repeat(43)}/confirm`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
        }),
      },
    );
    expect(unknownResourceConfirmation.status).toBe(404);
    const crossSessionConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        Cookie: secondSession.cookie,
        'X-LetheBot-CSRF': secondSession.csrfToken,
        'X-LetheBot-Scope': secondMemoryHandle,
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(crossSessionConfirmation.status).toBe(404);
    const crossPurposeConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': privacyHandle,
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(crossPurposeConfirmation.status).toBe(404);
    for (const body of [
      null,
      [],
      {},
      { confirm: false, previewHandle: previewBody.previewHandle },
      { confirm: true },
      { confirm: true, previewHandle: 'malformed' },
      { confirm: true, previewHandle: previewBody.previewHandle, action: 'forget' },
    ]) {
      const invalidConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidConfirmation.status).toBe(400);
      expect(await invalidConfirmation.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    const invalidJsonConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: '{',
    });
    expect(invalidJsonConfirmation.status).toBe(400);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(6);
    expect(forgetMemory).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);

    const unknownPreviewConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: 'z'.repeat(43),
      }),
    });
    expect(unknownPreviewConfirmation.status).toBe(404);
    expect(await unknownPreviewConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));

    const previewRegistry = issuePreviewHandle.mock.contexts[0] as
      GovernancePreviewHandleRegistry;
    const wrongActionPreview = previewRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: visibleResource?.handleExpiresAt ?? 0,
      actor: { kind: 'local_admin' },
      action: 'memory.maintenance.review.approve',
      resourceKind: 'memory_record',
      resourceId: visibleMemoryId,
      scope: { kind: 'user', canonicalUserId },
      expectedState: 'active',
      expectedRevisionNumber: 1,
      previewDigest: previewBody.previewDigest,
    });
    const wrongActionConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: wrongActionPreview.handle,
      }),
    });
    expect(wrongActionConfirmation.status).toBe(404);
    expect(await wrongActionConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(6);
    expect(forgetMemory).not.toHaveBeenCalled();

    const digestMismatchPreview = previewRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: visibleResource?.handleExpiresAt ?? 0,
      actor: { kind: 'local_admin' },
      action: 'memory.record.forget',
      resourceKind: 'memory_record',
      resourceId: visibleMemoryId,
      scope: { kind: 'user', canonicalUserId },
      expectedState: 'active',
      expectedRevisionNumber: 1,
      previewDigest: 'f'.repeat(64),
    });
    const digestMismatchConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: digestMismatchPreview.handle,
      }),
    });
    expect(digestMismatchConfirmation.status).toBe(409);
    expect(await digestMismatchConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(7);
    expect(forgetMemory).not.toHaveBeenCalled();

    type ForgetPreview = NonNullable<Awaited<ReturnType<
      GovernanceQueryService['getMemoryRecordForgetPreviewForScope']
    >>>;
    const driftedPreview: ForgetPreview = {
      action: 'memory.record.forget',
      recordRef: previewBody.recordRef,
      scopeKind: 'user',
      current: {
        lifecycleState: 'active',
        revisionNumber: 2,
      },
      expected: {
        lifecycleState: 'deleted',
        revisionNumber: 3,
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
      previewDigest: 'd'.repeat(64),
    };
    memoryForgetPreviewRead.mockResolvedValueOnce(driftedPreview);
    const driftedConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: repeatedPreview.previewHandle,
      }),
    });
    expect(driftedConfirmation.status).toBe(409);
    expect(await driftedConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(memoryForgetPreviewRead).toHaveBeenCalledTimes(8);
    expect(forgetMemory).not.toHaveBeenCalled();

    const expectedServiceInput = {
      memoryId: visibleMemoryId,
      scope: { kind: 'user' as const, canonicalUserId },
      expectedState: 'active' as const,
      expectedRevisionNumber: 1,
      reasonCode: 'governance_http_forget_confirmed',
    };
    forgetMemory.mockReturnValueOnce({ outcome: 'stale' });
    const staleServiceConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: staleServicePreview.previewHandle,
      }),
    });
    expect(staleServiceConfirmation.status).toBe(409);
    expect(await staleServiceConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(forgetMemory).toHaveBeenNthCalledWith(1, expectedServiceInput);

    forgetMemory.mockReturnValueOnce({ outcome: 'not_found' });
    const notFoundServiceConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: notFoundServicePreview.previewHandle,
      }),
    });
    expect(notFoundServiceConfirmation.status).toBe(404);
    expect(await notFoundServiceConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(forgetMemory).toHaveBeenNthCalledWith(2, expectedServiceInput);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);

    const confirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(confirmation.status).toBe(200);
    const confirmationText = await confirmation.text();
    expect(JSON.parse(confirmationText)).toEqual({
      action: 'memory.record.forget',
      outcome: 'forgotten',
      recordRef: previewBody.recordRef,
      scopeKind: 'user',
      current: {
        lifecycleState: 'deleted',
        revisionNumber: 2,
      },
      durableEffects: [
        'memory_record_state_transition',
        'memory_revision_append',
        'audit_event_append',
      ],
      retrievalConsequences: ['deleted_record_excluded'],
      evidence: {
        changeType: 'delete',
        revisionNumber: 2,
        auditEvent: 'memory.delete',
      },
      rollback: {
        supported: true,
        boundary: 'separate_restore_confirmation_required',
      },
    });
    expect(forgetMemory).toHaveBeenNthCalledWith(3, expectedServiceInput);
    expect(db.prepare(
      `SELECT state FROM memory_records WHERE id = ?`,
    ).get(visibleMemoryId)).toEqual({ state: 'deleted' });
    expect(db.prepare(
      `SELECT revision_number AS revisionNumber, change_type AS changeType,
              actor, reason
         FROM memory_revisions
        WHERE memory_id = ? ORDER BY revision_number`,
    ).all(visibleMemoryId)).toEqual([
      {
        revisionNumber: 1,
        changeType: 'update',
        actor: `memory-http-actor-${platformId}-${secret}`,
        reason: `memory-http-reason-${platformId}-${secret}`,
      },
      {
        revisionNumber: 2,
        changeType: 'delete',
        actor: 'local_admin',
        reason: 'Governance HTTP confirmed memory forget',
      },
    ]);
    const deleteAudit = db.prepare(
      `SELECT actor_user_id AS actorUserId, actor_class AS actorClass,
              invocation_context AS invocationContext, details
         FROM audit_log
        WHERE event_type = 'memory.delete' AND event_id = ?`,
    ).get(visibleMemoryId) as {
      actorUserId: string;
      actorClass: string;
      invocationContext: string;
      details: string;
    };
    expect({
      ...deleteAudit,
      details: JSON.parse(deleteAudit.details),
    }).toEqual({
      actorUserId: 'local_admin',
      actorClass: 'admin',
      invocationContext: 'admin_cli',
      details: expect.objectContaining({
        governanceActor: 'local_admin',
        reasonCode: 'governance_http_forget_confirmed',
        revisionNumber: 2,
      }),
    });
    expect((await new MemoryRepository(db).retrieve({
      canonicalUserId,
    })).map((memory) => memory.id)).not.toContain(visibleMemoryId);
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(restrictedMemoryId)).toEqual({ state: 'disabled' });

    for (const previewHandle of [
      previewBody.previewHandle,
      repeatedPreview.previewHandle,
    ]) {
      const consumedOrStaleConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ confirm: true, previewHandle }),
      });
      expect(consumedOrStaleConfirmation.status).toBe(409);
      expect(await consumedOrStaleConfirmation.text())
        .toBe(JSON.stringify({ error: 'conflict' }));
    }
    expect(forgetMemory).toHaveBeenCalledTimes(3);
    expect(db.prepare(
      `SELECT COUNT(*) FROM memory_revisions
        WHERE memory_id = ? AND change_type = 'delete'`,
    ).pluck().get(visibleMemoryId)).toBe(1);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.delete' AND event_id = ?`,
    ).pluck().get(visibleMemoryId)).toBe(1);
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      visibleMemoryId,
      visibleSourceId,
      visibleRevisionId,
      firstSessionDigest,
      visibleResource?.handle ?? '',
      previewBody.previewHandle,
    ]) {
      expect(confirmationText).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBeGreaterThan(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews and confirms exact Memory-record restores through current-session authority',
    async () => {
      const applicationPort = await reserveLoopbackPort();
      const governancePort = await reserveLoopbackPort();
      const platformId = '956789012';
      const secret = 'sk-memoryrestorehttpabcdefghijklmnopqrstuvwxyz123456';
      const canonicalUserId = `memory-restore-http-user-${platformId}-${secret}`;
      const disabledMemoryId = `memory-restore-http-disabled-${platformId}-${secret}`;
      const rejectedMemoryId = `memory-restore-http-rejected-${platformId}-${secret}`;
      const deletedMemoryId = `memory-restore-http-deleted-${platformId}-${secret}`;
      const activeMemoryId = `memory-restore-http-active-${platformId}-${secret}`;
      const revisionlessMemoryId =
        `memory-restore-http-revisionless-${platformId}-${secret}`;
      const missingMemoryId = `memory-restore-http-missing-${platformId}-${secret}`;
      const restorePreviewRead = vi.spyOn(
        GovernanceQueryService.prototype,
        'getMemoryRecordRestorePreviewForScope',
      );
      const forgetPreviewRead = vi.spyOn(
        GovernanceQueryService.prototype,
        'getMemoryRecordForgetPreviewForScope',
      );
      const issuePreviewHandle = vi.spyOn(
        GovernancePreviewHandleRegistry.prototype,
        'issue',
      );
      const consumePreviewHandle = vi.spyOn(
        GovernancePreviewHandleRegistry.prototype,
        'consumeWithOutcome',
      );
      const restoreMemory = vi.spyOn(
        GovernanceService.prototype,
        'restoreMemoryAsLocalAdmin',
      );
      const forgetMemory = vi.spyOn(
        GovernanceService.prototype,
        'forgetMemoryAsLocalAdmin',
      );
      const app = createTestApp(applicationPort, governancePort, {
        LETHEBOT_GOVERNANCE_ENABLED: 'true',
        LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
        LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
      });
      apps.push(app);

      await app.start();
      const db = app.getDatabase();
      const now = Date.parse('2032-01-15T00:00:00.000Z');
      db.prepare(
        `INSERT INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)`,
      ).run(canonicalUserId, now, now);
      const insertMemory = db.prepare(
        `INSERT INTO memory_records (
           id, scope, canonical_user_id, subject_user_id,
           visibility, sensitivity, authority, kind, title, content, state,
           confidence, importance, source_context, evaluator_decision_id,
           created_at, updated_at, expires_at
         ) VALUES (?, 'user', ?, ?, 'owner_admin_only', 'normal', 'system',
                   'fact', ?, ?, ?, 0.7, ?, ?, ?, ?, ?, NULL)`,
      );
      const records = [
        { id: disabledMemoryId, state: 'disabled', revisionCount: 1, importance: 0.9 },
        { id: rejectedMemoryId, state: 'rejected', revisionCount: 2, importance: 0.8 },
        { id: deletedMemoryId, state: 'deleted', revisionCount: 3, importance: 0.7 },
        { id: activeMemoryId, state: 'active', revisionCount: 1, importance: 0.6 },
        { id: revisionlessMemoryId, state: 'deleted', revisionCount: 0, importance: 0.5 },
        { id: missingMemoryId, state: 'deleted', revisionCount: 1, importance: 0.4 },
      ] as const;
      for (const [index, record] of records.entries()) {
        insertMemory.run(
          record.id,
          canonicalUserId,
          `memory-restore-http-subject-${index}-${platformId}-${secret}`,
          `Memory restore ${index} ${platformId}`,
          `api_key=${secret}-${index}`,
          record.state,
          record.importance,
          `memory_restore_http_source_${platformId}_${secret}`,
          `memory-restore-http-evaluator-${platformId}-${secret}`,
          now + index,
          now + index,
        );
        for (let revisionNumber = 1;
          revisionNumber <= record.revisionCount;
          revisionNumber += 1) {
          db.prepare(
            `INSERT INTO memory_revisions (
               id, memory_id, revision_number, change_type, previous_state,
               new_state, reason, actor, evaluator_decision_id, created_at
             ) VALUES (?, ?, ?, 'update', '{}', '{}', ?, ?, ?, ?)`,
          ).run(
            `memory-restore-http-revision-${index}-${revisionNumber}-${platformId}-${secret}`,
            record.id,
            revisionNumber,
            `memory-restore-http-reason-${platformId}-${secret}`,
            `memory-restore-http-actor-${platformId}-${secret}`,
            `memory-restore-http-revision-evaluator-${platformId}-${secret}`,
            now + revisionNumber,
          );
        }
      }

      const origin = `http://127.0.0.1:${governancePort}`;
      const recordsPath = `${API_PREFIX}/memory/records`;
      const firstSession = await loginGovernance(origin);
      const firstSessionDigest = digestSessionCookie(firstSession.cookie);
      const memoryCatalogResponse = await fetch(`${origin}${API_PREFIX}/memory/scopes`, {
        headers: { Connection: 'close', Cookie: firstSession.cookie },
      });
      expect(memoryCatalogResponse.status).toBe(200);
      const memoryCatalog = await memoryCatalogResponse.json() as {
        entries: Array<{ handle: string }>;
      };
      const memoryHandle = memoryCatalog.entries[0]?.handle ?? '';
      expect(memoryHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const pageResponse = await fetch(`${origin}${recordsPath}`, {
        headers: {
          Connection: 'close',
          Cookie: firstSession.cookie,
          'X-LetheBot-Scope': memoryHandle,
        },
      });
      expect(pageResponse.status).toBe(200);
      const page = await pageResponse.json() as {
        entries: Array<{
          recordRef: string;
          handle: string;
          handleExpiresAt: number;
        }>;
      };
      expect(page.entries).toHaveLength(records.length);
      const reference = (purpose: string, value: string) => createHash('sha256')
        .update(`lethebot-governance:${purpose}:v1\0`, 'utf8')
        .update(value, 'utf8')
        .digest('hex')
        .slice(0, 16);
      const resourceFor = (memoryId: string) => {
        const resource = page.entries.find(
          (entry) => entry.recordRef === reference('memory', memoryId),
        );
        if (!resource) {
          throw new Error('synthetic Memory restore resource is missing');
        }
        return resource;
      };
      const disabledResource = resourceFor(disabledMemoryId);
      const rejectedResource = resourceFor(rejectedMemoryId);
      const deletedResource = resourceFor(deletedMemoryId);
      const activeResource = resourceFor(activeMemoryId);
      const revisionlessResource = resourceFor(revisionlessMemoryId);
      const missingResource = resourceFor(missingMemoryId);

      const secondSession = await loginGovernance(origin);
      const secondMemoryCatalogResponse = await fetch(
        `${origin}${API_PREFIX}/memory/scopes`,
        { headers: { Connection: 'close', Cookie: secondSession.cookie } },
      );
      expect(secondMemoryCatalogResponse.status).toBe(200);
      const secondMemoryCatalog = await secondMemoryCatalogResponse.json() as {
        entries: Array<{ handle: string }>;
      };
      const secondMemoryHandle = secondMemoryCatalog.entries[0]?.handle ?? '';
      const privacyCatalogResponse = await fetch(`${origin}${API_PREFIX}/privacy/scopes`, {
        headers: { Connection: 'close', Cookie: firstSession.cookie },
      });
      expect(privacyCatalogResponse.status).toBe(200);
      const privacyCatalog = await privacyCatalogResponse.json() as {
        entries: Array<{ handle: string }>;
      };
      const privacyHandle = privacyCatalog.entries[0]?.handle ?? '';
      db.prepare('DELETE FROM memory_revisions WHERE memory_id = ?').run(missingMemoryId);
      db.prepare('DELETE FROM memory_records WHERE id = ?').run(missingMemoryId);
      const changesBeforeRequests = db.prepare('SELECT total_changes()').pluck().get();

      const previewHeaders = {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': memoryHandle,
        'Content-Type': 'application/json',
      };
      const disabledPath = `${recordsPath}/${disabledResource.handle}`;
      const unauthenticated = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(unauthenticated.status).toBe(401);
      const missingCsrf = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: { ...previewHeaders, 'X-LetheBot-CSRF': '' },
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(missingCsrf.status).toBe(403);
      const wrongOrigin = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: { ...previewHeaders, Origin: 'http://127.0.0.1:1' },
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(wrongOrigin.status).toBe(403);
      const queried = await fetch(`${origin}${disabledPath}?confirm=true`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(queried.status).toBe(400);
      const crossSession = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: {
          ...previewHeaders,
          Cookie: secondSession.cookie,
          'X-LetheBot-CSRF': secondSession.csrfToken,
          'X-LetheBot-Scope': secondMemoryHandle,
        },
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(crossSession.status).toBe(404);
      const crossPurpose = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: { ...previewHeaders, 'X-LetheBot-Scope': privacyHandle },
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(crossPurpose.status).toBe(404);
      const unknownResource = await fetch(`${origin}${recordsPath}/${'z'.repeat(43)}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(unknownResource.status).toBe(404);
      for (const body of [
        null,
        [],
        {},
        { action: 'enable' },
        { action: 'restore', memoryId: disabledMemoryId },
      ]) {
        const invalidBody = await fetch(`${origin}${disabledPath}`, {
          method: 'POST',
          headers: previewHeaders,
          body: JSON.stringify(body),
        });
        expect(invalidBody.status).toBe(400);
        expect(await invalidBody.text()).toBe(JSON.stringify({ error: 'bad_request' }));
      }
      const invalidJson = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: '{',
      });
      expect(invalidJson.status).toBe(400);
      expect(restorePreviewRead).not.toHaveBeenCalled();
      expect(issuePreviewHandle).not.toHaveBeenCalled();
      expect(consumePreviewHandle).not.toHaveBeenCalled();
      expect(restoreMemory).not.toHaveBeenCalled();
      expect(forgetMemory).not.toHaveBeenCalled();

      const previewResponse = await fetch(`${origin}${disabledPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({ action: 'restore' }),
      });
      expect(previewResponse.status).toBe(201);
      const previewText = await previewResponse.text();
      const previewBody = JSON.parse(previewText) as {
        action: string;
        recordRef: string;
        scopeKind: string;
        current: { lifecycleState: string; revisionNumber: number };
        expected: Record<string, unknown>;
        rollback: Record<string, unknown>;
        previewDigest: string;
        previewHandle: string;
        previewExpiresAt: number;
      };
      expect(previewBody).toEqual({
        action: 'memory.record.restore',
        recordRef: reference('memory-record-restore', disabledMemoryId),
        scopeKind: 'user',
        current: {
          lifecycleState: 'disabled',
          revisionNumber: 1,
        },
        expected: {
          lifecycleState: 'active',
          revisionNumber: 2,
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
        previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        previewExpiresAt: disabledResource.handleExpiresAt,
      });
      expect(Object.keys(previewBody).sort()).toEqual([
        'action',
        'current',
        'expected',
        'previewDigest',
        'previewExpiresAt',
        'previewHandle',
        'recordRef',
        'rollback',
        'scopeKind',
      ]);
      expect(restorePreviewRead).toHaveBeenCalledTimes(1);
      expect(restorePreviewRead).toHaveBeenLastCalledWith({
        scope: { kind: 'user', canonicalUserId },
        memoryId: disabledMemoryId,
      });
      expect(issuePreviewHandle).toHaveBeenCalledTimes(1);
      expect(issuePreviewHandle).toHaveBeenLastCalledWith({
        sessionId: firstSessionDigest,
        sessionExpiresAt: disabledResource.handleExpiresAt,
        actor: { kind: 'local_admin' },
        action: 'memory.record.restore',
        resourceKind: 'memory_record',
        resourceId: disabledMemoryId,
        scope: { kind: 'user', canonicalUserId },
        expectedState: 'disabled',
        expectedRevisionNumber: 1,
        previewDigest: previewBody.previewDigest,
      });
      expect(forgetPreviewRead).not.toHaveBeenCalled();
      expect(consumePreviewHandle).not.toHaveBeenCalled();
      expect(restoreMemory).not.toHaveBeenCalled();
      expect(forgetMemory).not.toHaveBeenCalled();

      for (const [resource, expectedState, expectedRevisionNumber] of [
        [missingResource, null, null],
        [activeResource, null, null],
        [revisionlessResource, null, null],
        [rejectedResource, 'rejected', 2],
        [deletedResource, 'deleted', 3],
      ] as const) {
        const response = await fetch(`${origin}${recordsPath}/${resource.handle}`, {
          method: 'POST',
          headers: previewHeaders,
          body: JSON.stringify({ action: 'restore' }),
        });
        if (expectedState === null) {
          expect(response.status).toBe(404);
          expect(await response.text()).toBe(JSON.stringify({ error: 'not_found' }));
          continue;
        }
        expect(response.status).toBe(201);
        const body = await response.json() as {
          action: string;
          current: { lifecycleState: string; revisionNumber: number };
          expected: { lifecycleState: string; revisionNumber: number };
          previewHandle: string;
        };
        expect(body).toMatchObject({
          action: 'memory.record.restore',
          current: {
            lifecycleState: expectedState,
            revisionNumber: expectedRevisionNumber,
          },
          expected: {
            lifecycleState: 'active',
            revisionNumber: expectedRevisionNumber + 1,
          },
          previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });
      }
      expect(restorePreviewRead).toHaveBeenCalledTimes(6);
      expect(issuePreviewHandle).toHaveBeenCalledTimes(3);
      expect(forgetPreviewRead).not.toHaveBeenCalled();
      expect(consumePreviewHandle).not.toHaveBeenCalled();
      expect(restoreMemory).not.toHaveBeenCalled();
      expect(forgetMemory).not.toHaveBeenCalled();

      const confirmPath = `${disabledPath}/confirm`;
      const unauthenticatedConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(unauthenticatedConfirmation.status).toBe(401);
      const missingConfirmationCsrf = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: { ...previewHeaders, 'X-LetheBot-CSRF': '' },
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(missingConfirmationCsrf.status).toBe(403);
      const wrongConfirmationOrigin = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: { ...previewHeaders, Origin: 'http://127.0.0.1:1' },
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(wrongConfirmationOrigin.status).toBe(403);
      const queriedConfirmation = await fetch(`${origin}${confirmPath}?action=restore`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(queriedConfirmation.status).toBe(400);
      const crossSessionConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: {
          ...previewHeaders,
          Cookie: secondSession.cookie,
          'X-LetheBot-CSRF': secondSession.csrfToken,
          'X-LetheBot-Scope': secondMemoryHandle,
        },
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(crossSessionConfirmation.status).toBe(404);
      const crossPurposeConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: { ...previewHeaders, 'X-LetheBot-Scope': privacyHandle },
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(crossPurposeConfirmation.status).toBe(404);
      for (const body of [
        null,
        [],
        {},
        { confirm: true },
        { confirm: true, previewHandle: 'z'.repeat(43), action: 'enable' },
        { confirm: true, previewHandle: previewBody.previewHandle, action: 'restore', extra: true },
      ]) {
        const invalidConfirmation = await fetch(`${origin}${confirmPath}`, {
          method: 'POST',
          headers: previewHeaders,
          body: JSON.stringify(body),
        });
        expect(invalidConfirmation.status).toBe(400);
        expect(await invalidConfirmation.text()).toBe(JSON.stringify({ error: 'bad_request' }));
      }
      const unavailableForgetConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
        }),
      });
      expect(unavailableForgetConfirmation.status).toBe(404);
      expect(await unavailableForgetConfirmation.text())
        .toBe(JSON.stringify({ error: 'not_found' }));
      expect(consumePreviewHandle).toHaveBeenCalledTimes(1);
      expect(consumePreviewHandle).toHaveBeenLastCalledWith({
        sessionId: firstSessionDigest,
        handle: previewBody.previewHandle,
        actor: { kind: 'local_admin' },
        action: 'memory.record.forget',
        resourceKind: 'memory_record',
        resourceId: disabledMemoryId,
        scope: { kind: 'user', canonicalUserId },
      });
      expect(restoreMemory).not.toHaveBeenCalled();
      expect(forgetMemory).not.toHaveBeenCalled();
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeRequests);

      const confirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(confirmation.status).toBe(200);
      const confirmationBody = await confirmation.json() as {
        action: string;
        outcome: string;
        recordRef: string;
        scopeKind: string;
        current: { lifecycleState: string; revisionNumber: number };
        durableEffects: string[];
        retrievalConsequences: string[];
        evidence: { changeType: string; revisionNumber: number; auditEvent: string };
        rollback: Record<string, unknown>;
      };
      expect(confirmationBody).toEqual({
        action: 'memory.record.restore',
        outcome: 'restored',
        recordRef: previewBody.recordRef,
        scopeKind: 'user',
        current: {
          lifecycleState: 'active',
          revisionNumber: 2,
        },
        durableEffects: [
          'memory_record_state_transition',
          'memory_revision_append',
          'audit_event_append',
        ],
        retrievalConsequences: ['restored_records_included'],
        evidence: {
          changeType: 'restore',
          revisionNumber: 2,
          auditEvent: 'memory.restore',
        },
        rollback: {
          supported: true,
          boundary: 'separate_forget_confirmation_required',
        },
      });
      expect(Object.keys(confirmationBody).sort()).toEqual([
        'action',
        'current',
        'durableEffects',
        'evidence',
        'outcome',
        'recordRef',
        'retrievalConsequences',
        'rollback',
        'scopeKind',
      ]);
      expect(consumePreviewHandle).toHaveBeenCalledTimes(2);
      expect(consumePreviewHandle).toHaveBeenLastCalledWith({
        sessionId: firstSessionDigest,
        handle: previewBody.previewHandle,
        actor: { kind: 'local_admin' },
        action: 'memory.record.restore',
        resourceKind: 'memory_record',
        resourceId: disabledMemoryId,
        scope: { kind: 'user', canonicalUserId },
      });
      expect(restorePreviewRead).toHaveBeenCalledTimes(7);
      expect(restoreMemory).toHaveBeenCalledTimes(1);
      expect(restoreMemory).toHaveBeenLastCalledWith({
        memoryId: disabledMemoryId,
        scope: { kind: 'user', canonicalUserId },
        expectedState: 'disabled',
        expectedRevisionNumber: 1,
        reasonCode: 'governance_http_restore_confirmed',
      });
      expect(forgetMemory).not.toHaveBeenCalled();
      expect(db.prepare(
        `SELECT state FROM memory_records WHERE id = ?`,
      ).get(disabledMemoryId)).toEqual({ state: 'active' });
      expect(db.prepare(
        `SELECT revision_number AS revisionNumber, change_type AS changeType,
                actor, reason
           FROM memory_revisions
          WHERE memory_id = ? AND change_type = 'restore'`,
      ).get(disabledMemoryId)).toEqual({
        revisionNumber: 2,
        changeType: 'restore',
        actor: 'local_admin',
        reason: 'Governance HTTP confirmed memory restore',
      });
      const disabledAudit = db.prepare(
        `SELECT event_type AS eventType, actor_user_id AS actorUserId,
                actor_class AS actorClass, invocation_context AS invocationContext,
                details
           FROM audit_log
          WHERE event_id = ? AND event_type = 'memory.restore'`,
      ).get(disabledMemoryId) as {
        eventType: string;
        actorUserId: string;
        actorClass: string;
        invocationContext: string;
        details: string;
      };
      expect({
        ...disabledAudit,
        details: JSON.parse(disabledAudit.details),
      }).toEqual({
        eventType: 'memory.restore',
        actorUserId: 'local_admin',
        actorClass: 'admin',
        invocationContext: 'admin_cli',
        details: expect.objectContaining({
          reasonCode: 'governance_http_restore_confirmed',
          revisionNumber: 2,
        }),
      });
      expect((await new MemoryRepository(db).retrieve({ state: 'active', limit: 100 }))
        .map((memory) => memory.id)).toContain(disabledMemoryId);

      const reusedConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: previewBody.previewHandle,
          action: 'restore',
        }),
      });
      expect(reusedConfirmation.status).toBe(409);
      expect(await reusedConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
      expect(restorePreviewRead).toHaveBeenCalledTimes(7);
      expect(restoreMemory).toHaveBeenCalledTimes(1);

      type RestorePreviewBody = typeof previewBody;
      const requestRestorePreview = async (resource: { handle: string }) => {
        const response = await fetch(`${origin}${recordsPath}/${resource.handle}`, {
          method: 'POST',
          headers: previewHeaders,
          body: JSON.stringify({ action: 'restore' }),
        });
        expect(response.status).toBe(201);
        return response.json() as Promise<RestorePreviewBody>;
      };
      const confirmRestore = async (resource: { handle: string }, handle: string) => fetch(
        `${origin}${recordsPath}/${resource.handle}/confirm`,
        {
          method: 'POST',
          headers: previewHeaders,
          body: JSON.stringify({ confirm: true, previewHandle: handle, action: 'restore' }),
        },
      );

      const nullPreview = await requestRestorePreview(rejectedResource);
      restorePreviewRead.mockResolvedValueOnce(null);
      const missingAfterPreview = await confirmRestore(rejectedResource, nullPreview.previewHandle);
      expect(missingAfterPreview.status).toBe(409);
      expect(await missingAfterPreview.text()).toBe(JSON.stringify({ error: 'conflict' }));
      expect(restoreMemory).toHaveBeenCalledTimes(1);

      const staleServicePreview = await requestRestorePreview(rejectedResource);
      restoreMemory.mockReturnValueOnce({ outcome: 'stale' });
      const staleServiceConfirmation = await confirmRestore(
        rejectedResource,
        staleServicePreview.previewHandle,
      );
      expect(staleServiceConfirmation.status).toBe(409);
      expect(await staleServiceConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
      expect(restoreMemory).toHaveBeenCalledTimes(2);

      const missingServicePreview = await requestRestorePreview(rejectedResource);
      restoreMemory.mockReturnValueOnce({ outcome: 'not_found' });
      const missingServiceConfirmation = await confirmRestore(
        rejectedResource,
        missingServicePreview.previewHandle,
      );
      expect(missingServiceConfirmation.status).toBe(404);
      expect(await missingServiceConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
      expect(restoreMemory).toHaveBeenCalledTimes(3);

      const wrongResourcePreview = await requestRestorePreview(rejectedResource);
      const wrongResourceConfirmation = await confirmRestore(
        deletedResource,
        wrongResourcePreview.previewHandle,
      );
      expect(wrongResourceConfirmation.status).toBe(404);
      expect(await wrongResourceConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
      expect(restoreMemory).toHaveBeenCalledTimes(3);

      const forgetPreviewResponse = await fetch(
        `${origin}${recordsPath}/${activeResource.handle}`,
        {
          method: 'POST',
          headers: previewHeaders,
          body: JSON.stringify({ action: 'forget' }),
        },
      );
      expect(forgetPreviewResponse.status).toBe(201);
      const forgetPreviewBody = await forgetPreviewResponse.json() as { previewHandle: string };
      const wrongActionConfirmation = await confirmRestore(
        activeResource,
        forgetPreviewBody.previewHandle,
      );
      expect(wrongActionConfirmation.status).toBe(404);
      expect(await wrongActionConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
      expect(restoreMemory).toHaveBeenCalledTimes(3);
      expect(forgetMemory).not.toHaveBeenCalled();

      const rejectedConfirmation = await confirmRestore(
        rejectedResource,
        wrongResourcePreview.previewHandle,
      );
      expect(rejectedConfirmation.status).toBe(200);
      expect(await rejectedConfirmation.json()).toMatchObject({
        action: 'memory.record.restore',
        outcome: 'restored',
        current: { lifecycleState: 'active', revisionNumber: 3 },
      });
      expect(restoreMemory).toHaveBeenCalledTimes(4);

      const driftedPreview = await requestRestorePreview(deletedResource);
      db.prepare(
        `INSERT INTO memory_revisions (
           id, memory_id, revision_number, change_type, previous_state,
           new_state, reason, actor, evaluator_decision_id, created_at
         ) VALUES (?, ?, 4, 'update', '{}', '{}', ?, ?, ?, ?)`,
      ).run(
        `memory-restore-http-drift-${platformId}-${secret}`,
        deletedMemoryId,
        `memory-restore-http-drift-reason-${platformId}-${secret}`,
        `memory-restore-http-drift-actor-${platformId}-${secret}`,
        `memory-restore-http-drift-evaluator-${platformId}-${secret}`,
        now + 100,
      );
      const driftedConfirmation = await confirmRestore(
        deletedResource,
        driftedPreview.previewHandle,
      );
      expect(driftedConfirmation.status).toBe(409);
      expect(await driftedConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
      expect(restoreMemory).toHaveBeenCalledTimes(4);

      const currentDeletedPreview = await requestRestorePreview(deletedResource);
      expect(currentDeletedPreview.current).toEqual({
        lifecycleState: 'deleted',
        revisionNumber: 4,
      });
      const deletedConfirmation = await confirmRestore(
        deletedResource,
        currentDeletedPreview.previewHandle,
      );
      expect(deletedConfirmation.status).toBe(200);
      expect(await deletedConfirmation.json()).toMatchObject({
        action: 'memory.record.restore',
        outcome: 'restored',
        current: { lifecycleState: 'active', revisionNumber: 5 },
      });
      expect(restoreMemory).toHaveBeenCalledTimes(5);
      expect(db.prepare(
        `SELECT id, state FROM memory_records
          WHERE id IN (?, ?, ?) ORDER BY id`,
      ).all(disabledMemoryId, rejectedMemoryId, deletedMemoryId)).toEqual([
        { id: deletedMemoryId, state: 'active' },
        { id: disabledMemoryId, state: 'active' },
        { id: rejectedMemoryId, state: 'active' },
      ]);
      expect(db.prepare(
        `SELECT memory_id AS memoryId, revision_number AS revisionNumber,
                change_type AS changeType
           FROM memory_revisions
          WHERE memory_id IN (?, ?, ?) AND change_type = 'restore'
          ORDER BY memory_id`,
      ).all(disabledMemoryId, rejectedMemoryId, deletedMemoryId)).toEqual([
        { memoryId: deletedMemoryId, revisionNumber: 5, changeType: 'restore' },
        { memoryId: disabledMemoryId, revisionNumber: 2, changeType: 'restore' },
        { memoryId: rejectedMemoryId, revisionNumber: 3, changeType: 'restore' },
      ]);
      expect(db.prepare(
        `SELECT event_id AS memoryId, COUNT(*) AS count
           FROM audit_log
          WHERE event_id IN (?, ?, ?) AND event_type = 'memory.restore'
          GROUP BY event_id ORDER BY event_id`,
      ).all(disabledMemoryId, rejectedMemoryId, deletedMemoryId)).toEqual([
        { memoryId: deletedMemoryId, count: 1 },
        { memoryId: disabledMemoryId, count: 1 },
        { memoryId: rejectedMemoryId, count: 1 },
      ]);

      const serialized = JSON.stringify({ previewBody, confirmationBody });
      for (const rawValue of [
        platformId,
        secret,
        canonicalUserId,
        disabledMemoryId,
        `memory-restore-http-subject-0-${platformId}-${secret}`,
        `Memory restore 0 ${platformId}`,
        `api_key=${secret}-0`,
        `memory_restore_http_source_${platformId}_${secret}`,
        `memory-restore-http-evaluator-${platformId}-${secret}`,
        firstSessionDigest,
        disabledResource.handle,
      ]) {
        expect(serialized).not.toContain(rawValue);
      }
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

  it('serves only the exact scoped owner-free Privacy preference page', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '945678901';
    const secret = 'privacyhttppasswordsecret';
    const canonicalUserId = `privacy-http-page-user-${platformId}`;
    const updaterUserId = `privacy-http-page-updater-${platformId}`;
    const preferenceRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listPrivacyPreferencesForScope',
    );
    const originalPrivacyPreferenceChangePreviewRead =
      GovernanceQueryService.prototype.getPrivacyPreferenceChangePreviewForScope;
    const preferenceChangePreviewRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'getPrivacyPreferenceChangePreviewForScope',
    );
    const resolveScopeHandle = vi.spyOn(
      GovernanceScopeHandleRegistry.prototype,
      'resolve',
    );
    const issuePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'issue',
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const setPrivacyPreference = vi.spyOn(
      GovernanceService.prototype,
      'setPrivacyPreferenceAsLocalAdmin',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    const now = Date.parse('2032-01-12T00:00:00.000Z');
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?), (?, ?, ?)`,
    ).run(
      canonicalUserId,
      now,
      now + 100,
      updaterUserId,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO privacy_preferences (
         canonical_user_id, preference_type, state, reason,
         updated_by_user_id, updated_by_actor_class, updated_by_context,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      canonicalUserId,
      'memory_association',
      'opted_out',
      `password=${secret}`,
      updaterUserId,
      `admin-${platformId}`,
      `admin_cli password=${secret}`,
      now + 1,
      now + 2,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/privacy/preferences`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(preferenceRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const unauthenticatedPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'change',
        preferenceType: 'memory_association',
        targetState: 'opted_in',
      }),
    });
    expect(unauthenticatedPreview.status).toBe(401);
    expect(await unauthenticatedPreview.text())
      .toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(preferenceChangePreviewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(setPrivacyPreference).not.toHaveBeenCalled();

    const unauthenticatedConfirmation = await fetch(`${origin}${path}/confirm`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: 'a'.repeat(43),
        preferenceType: 'memory_association',
        targetState: 'opted_in',
      }),
    });
    expect(unauthenticatedConfirmation.status).toBe(401);
    expect(await unauthenticatedConfirmation.text())
      .toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(setPrivacyPreference).not.toHaveBeenCalled();

    const firstSession = await loginGovernance(origin);
    const firstSessionDigest = digestSessionCookie(firstSession.cookie);
    const catalogResponse = await fetch(`${origin}${API_PREFIX}/privacy/scopes`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      entries: Array<{
        scopeKind: string;
        handle: string;
        expiresAt: number;
      }>;
    };
    expect(catalog.entries).toHaveLength(2);
    const privacyHandle = catalog.entries[0]?.handle ?? '';
    const implicitPrivacyHandle = catalog.entries[1]?.handle ?? '';
    expect(privacyHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(implicitPrivacyHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();

    const missingScope = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: firstSession.cookie },
    });
    expect(missingScope.status).toBe(400);
    expect(preferenceRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const malformedScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'malformed',
      },
    });
    expect(malformedScope.status).toBe(400);
    expect(preferenceRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const withQuery = await fetch(`${origin}${path}?canonicalUserId=raw`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(withQuery.status).toBe(400);
    expect(preferenceRead).not.toHaveBeenCalled();
    expect(resolveScopeHandle).not.toHaveBeenCalled();

    const unknownScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': 'z'.repeat(43),
      },
    });
    expect(unknownScope.status).toBe(404);
    expect(preferenceRead).not.toHaveBeenCalled();

    const secondSession = await loginGovernance(origin);
    const crossSession = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: secondSession.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(crossSession.status).toBe(404);
    expect(preferenceRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({
      entries: [{
        preferenceType: 'memory_association',
        state: 'opted_out',
        reason: '[REDACTED:password_assignment]',
        updatedBy: {
          actorClass: 'admin-[REDACTED:platform_id]',
          context: 'admin_cli [REDACTED:password_assignment]',
        },
        createdAt: new Date(now + 1).toISOString(),
        updatedAt: new Date(now + 2).toISOString(),
      }],
      truncated: false,
    });
    expect(preferenceRead).toHaveBeenCalledTimes(1);
    expect(preferenceRead).toHaveBeenCalledWith({
      kind: 'user',
      canonicalUserId,
    });
    expect(resolveScopeHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      handle: privacyHandle,
      purpose: 'governance.privacy.preferences.read',
    });
    expect(responseText).not.toContain(canonicalUserId);
    expect(responseText).not.toContain(updaterUserId);
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(secret);
    expect(responseText).not.toContain(firstSessionDigest);

    const repeated = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        'X-LetheBot-Scope': privacyHandle,
      },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(preferenceRead).toHaveBeenCalledTimes(2);

    const previewHeaders = {
      Connection: 'close',
      Cookie: firstSession.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': firstSession.csrfToken,
      'X-LetheBot-Scope': privacyHandle,
      'Content-Type': 'application/json',
    };
    const storedChangeBody = {
      action: 'change',
      preferenceType: 'memory_association',
      targetState: 'opted_in',
    };
    const missingCsrfPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-CSRF': '' },
      body: JSON.stringify(storedChangeBody),
    });
    expect(missingCsrfPreview.status).toBe(403);
    const wrongOriginPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, Origin: 'http://127.0.0.1:1' },
      body: JSON.stringify(storedChangeBody),
    });
    expect(wrongOriginPreview.status).toBe(403);
    const crossSessionCsrfPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': secondSession.csrfToken,
      },
      body: JSON.stringify(storedChangeBody),
    });
    expect(crossSessionCsrfPreview.status).toBe(403);
    const missingScopePreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': '' },
      body: JSON.stringify(storedChangeBody),
    });
    expect(missingScopePreview.status).toBe(400);
    const malformedScopePreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': 'malformed' },
      body: JSON.stringify(storedChangeBody),
    });
    expect(malformedScopePreview.status).toBe(400);
    const queriedPreview = await fetch(`${origin}${path}?target=raw`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(storedChangeBody),
    });
    expect(queriedPreview.status).toBe(400);
    const unknownScopePreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': 'z'.repeat(43) },
      body: JSON.stringify(storedChangeBody),
    });
    expect(unknownScopePreview.status).toBe(404);
    const crossSessionPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        Cookie: secondSession.cookie,
        'X-LetheBot-CSRF': secondSession.csrfToken,
      },
      body: JSON.stringify(storedChangeBody),
    });
    expect(crossSessionPreview.status).toBe(404);
    const scopeRegistry = resolveScopeHandle.mock.contexts[0] as
      GovernanceScopeHandleRegistry;
    const privacyScopeExpiresAt = catalog.entries[0]?.expiresAt ?? 0;
    expect(Number.isSafeInteger(privacyScopeExpiresAt)).toBe(true);
    const crossPurposeScope = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: privacyScopeExpiresAt,
      purpose: 'governance.memory.records.read',
      scope: { kind: 'user', canonicalUserId },
    });
    const crossPurposePreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': crossPurposeScope.handle,
      },
      body: JSON.stringify(storedChangeBody),
    });
    expect(crossPurposePreview.status).toBe(404);
    const missingContentTypePreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': privacyHandle,
      },
      body: JSON.stringify(storedChangeBody),
    });
    expect(missingContentTypePreview.status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { action: 'set', preferenceType: 'memory_association', targetState: 'opted_in' },
      { action: 'change', preferenceType: 'unsupported', targetState: 'opted_in' },
      { action: 'change', preferenceType: 'memory_association', targetState: 'enabled' },
      { ...storedChangeBody, extra: true },
    ]) {
      const invalidBodyPreview = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBodyPreview.status).toBe(400);
      expect(await invalidBodyPreview.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    const invalidJsonPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: '{',
    });
    expect(invalidJsonPreview.status).toBe(400);
    expect(preferenceChangePreviewRead).not.toHaveBeenCalled();
    expect(issuePreviewHandle).not.toHaveBeenCalled();
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(setPrivacyPreference).not.toHaveBeenCalled();

    const storedPreviewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(storedChangeBody),
    });
    expect(storedPreviewResponse.status).toBe(201);
    const storedPreviewText = await storedPreviewResponse.text();
    const storedPreview = JSON.parse(storedPreviewText) as {
      action: string;
      preferenceType: string;
      current: {
        state: string;
        version: { source: string; updatedAt: number | null };
      };
      expected: Record<string, unknown>;
      rollback: Record<string, unknown>;
      previewDigest: string;
      previewHandle: string;
      previewExpiresAt: number;
    };
    expect(storedPreview).toEqual({
      action: 'privacy.preference.change',
      preferenceType: 'memory_association',
      current: {
        state: 'opted_out',
        version: {
          source: 'stored_preference',
          updatedAt: now + 2,
        },
      },
      expected: {
        state: 'opted_in',
        durableEffects: [
          'privacy_preference_upsert',
          'audit_event_append',
        ],
        enforcementConsequences: ['preference_enforced_immediately'],
      },
      rollback: {
        supported: true,
        targetState: 'opted_out',
        boundary: 'separate_preference_change_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: privacyScopeExpiresAt,
    });
    expect(Object.keys(storedPreview).sort()).toEqual([
      'action',
      'current',
      'expected',
      'preferenceType',
      'previewDigest',
      'previewExpiresAt',
      'previewHandle',
      'rollback',
    ]);
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(1);
    expect(preferenceChangePreviewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId },
      preferenceType: 'memory_association',
      targetState: 'opted_in',
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(1);
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt: privacyScopeExpiresAt,
      actor: { kind: 'local_admin' },
      action: 'privacy.preference.change',
      resourceKind: 'privacy_preference',
      resourceId: 'memory_association',
      scope: { kind: 'user', canonicalUserId },
      expectedState: 'opted_out',
      expectedRevisionNumber: now + 2,
      previewDigest: storedPreview.previewDigest,
    });
    for (const rawValue of [
      canonicalUserId,
      updaterUserId,
      platformId,
      secret,
      firstSessionDigest,
      privacyHandle,
    ]) {
      expect(storedPreviewText).not.toContain(rawValue);
    }

    const repeatedPreviewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(storedChangeBody),
    });
    expect(repeatedPreviewResponse.status).toBe(201);
    const repeatedPreview = await repeatedPreviewResponse.json() as typeof storedPreview;
    expect(repeatedPreview.previewDigest).toBe(storedPreview.previewDigest);
    expect(repeatedPreview.previewHandle).not.toBe(storedPreview.previewHandle);
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(2);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(2);

    const implicitPreviewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': implicitPrivacyHandle,
      },
      body: JSON.stringify({
        action: 'change',
        preferenceType: 'proactive_dm',
        targetState: 'opted_out',
      }),
    });
    expect(implicitPreviewResponse.status).toBe(201);
    const implicitPreview = await implicitPreviewResponse.json() as typeof storedPreview;
    expect(implicitPreview).toEqual({
      action: 'privacy.preference.change',
      preferenceType: 'proactive_dm',
      current: {
        state: 'opted_in',
        version: {
          source: 'implicit_default',
          updatedAt: null,
        },
      },
      expected: {
        state: 'opted_out',
        durableEffects: [
          'privacy_preference_upsert',
          'audit_event_append',
        ],
        enforcementConsequences: ['preference_enforced_immediately'],
      },
      rollback: {
        supported: true,
        targetState: 'opted_in',
        boundary: 'separate_preference_change_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: catalog.entries[1]?.expiresAt,
    });
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(3);
    expect(preferenceChangePreviewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId: updaterUserId },
      preferenceType: 'proactive_dm',
      targetState: 'opted_out',
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(3);
    expect(issuePreviewHandle).toHaveBeenLastCalledWith({
      sessionId: firstSessionDigest,
      sessionExpiresAt: catalog.entries[1]?.expiresAt,
      actor: { kind: 'local_admin' },
      action: 'privacy.preference.change',
      resourceKind: 'privacy_preference',
      resourceId: 'proactive_dm',
      scope: { kind: 'user', canonicalUserId: updaterUserId },
      expectedState: 'opted_in',
      expectedRevisionNumber: 1,
      previewDigest: implicitPreview.previewDigest,
    });

    for (const [scopeHandle, body] of [
      [privacyHandle, {
        action: 'change',
        preferenceType: 'memory_association',
        targetState: 'opted_out',
      }],
      [implicitPrivacyHandle, {
        action: 'change',
        preferenceType: 'proactive_dm',
        targetState: 'opted_in',
      }],
    ] as const) {
      const noOpPreview = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { ...previewHeaders, 'X-LetheBot-Scope': scopeHandle },
        body: JSON.stringify(body),
      });
      expect(noOpPreview.status).toBe(404);
      expect(await noOpPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));
    }
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(5);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(3);

    const missingCanonicalUserId = `privacy-http-missing-${platformId}-${secret}`;
    const missingUserScope = scopeRegistry.issue({
      sessionId: firstSessionDigest,
      sessionExpiresAt: privacyScopeExpiresAt,
      purpose: 'governance.privacy.preferences.read',
      scope: { kind: 'user', canonicalUserId: missingCanonicalUserId },
    });
    const missingUserPreview = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': missingUserScope.handle,
      },
      body: JSON.stringify({
        action: 'change',
        preferenceType: 'proactive_dm',
        targetState: 'opted_out',
      }),
    });
    expect(missingUserPreview.status).toBe(404);
    expect(await missingUserPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(6);
    expect(preferenceChangePreviewRead).toHaveBeenLastCalledWith({
      scope: { kind: 'user', canonicalUserId: missingCanonicalUserId },
      preferenceType: 'proactive_dm',
      targetState: 'opted_out',
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(3);

    const confirmationPath = `${path}/confirm`;
    const storedConfirmationBody = {
      confirm: true,
      previewHandle: storedPreview.previewHandle,
      preferenceType: 'memory_association',
      targetState: 'opted_in',
    };
    const previewReadsBeforeConfirmations = preferenceChangePreviewRead.mock.calls.length;
    const changesBeforeConfirmations = db.prepare('SELECT total_changes()').pluck().get();

    const missingCsrfConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-CSRF': '' },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(missingCsrfConfirmation.status).toBe(403);
    const wrongOriginConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: { ...previewHeaders, Origin: 'http://127.0.0.1:1' },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(wrongOriginConfirmation.status).toBe(403);
    const queriedConfirmation = await fetch(`${origin}${confirmationPath}?raw=true`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(queriedConfirmation.status).toBe(400);
    const missingScopeConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': '' },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(missingScopeConfirmation.status).toBe(400);
    const malformedScopeConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': 'malformed' },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(malformedScopeConfirmation.status).toBe(400);
    const unknownScopeConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: { ...previewHeaders, 'X-LetheBot-Scope': 'z'.repeat(43) },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(unknownScopeConfirmation.status).toBe(404);
    const crossSessionConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        Cookie: secondSession.cookie,
        'X-LetheBot-CSRF': secondSession.csrfToken,
      },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(crossSessionConfirmation.status).toBe(404);
    const crossPurposeConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': crossPurposeScope.handle,
      },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(crossPurposeConfirmation.status).toBe(404);
    const missingContentTypeConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: firstSession.cookie,
        Origin: origin,
        'X-LetheBot-CSRF': firstSession.csrfToken,
        'X-LetheBot-Scope': privacyHandle,
      },
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(missingContentTypeConfirmation.status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { confirm: true, previewHandle: storedPreview.previewHandle },
      { ...storedConfirmationBody, confirm: false },
      { ...storedConfirmationBody, previewHandle: 'malformed' },
      { ...storedConfirmationBody, preferenceType: 'unsupported' },
      { ...storedConfirmationBody, targetState: 'enabled' },
      { ...storedConfirmationBody, extra: true },
    ]) {
      const invalidBodyConfirmation = await fetch(`${origin}${confirmationPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBodyConfirmation.status).toBe(400);
      expect(await invalidBodyConfirmation.text())
        .toBe(JSON.stringify({ error: 'bad_request' }));
    }
    const invalidJsonConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: '{',
    });
    expect(invalidJsonConfirmation.status).toBe(400);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(previewReadsBeforeConfirmations);
    expect(setPrivacyPreference).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeConfirmations);

    const unknownPreviewConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        ...storedConfirmationBody,
        previewHandle: 'z'.repeat(43),
      }),
    });
    expect(unknownPreviewConfirmation.status).toBe(404);
    expect(await unknownPreviewConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(previewReadsBeforeConfirmations);
    expect(setPrivacyPreference).not.toHaveBeenCalled();

    const wrongTypeConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        ...storedConfirmationBody,
        preferenceType: 'proactive_dm',
      }),
    });
    expect(wrongTypeConfirmation.status).toBe(404);
    expect(preferenceChangePreviewRead).toHaveBeenCalledTimes(previewReadsBeforeConfirmations);
    expect(setPrivacyPreference).not.toHaveBeenCalled();

    const wrongTargetConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        ...storedConfirmationBody,
        previewHandle: repeatedPreview.previewHandle,
        targetState: 'opted_out',
      }),
    });
    expect(wrongTargetConfirmation.status).toBe(409);
    expect(await wrongTargetConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(preferenceChangePreviewRead)
      .toHaveBeenCalledTimes(previewReadsBeforeConfirmations + 1);
    expect(setPrivacyPreference).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeConfirmations);

    const storedConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(storedConfirmation.status).toBe(200);
    const storedConfirmationText = await storedConfirmation.text();
    expect(JSON.parse(storedConfirmationText)).toEqual({
      action: 'privacy.preference.change',
      outcome: 'updated',
      preferenceType: 'memory_association',
      current: {
        state: 'opted_in',
        version: {
          source: 'stored_preference',
          updatedAt: now + 3,
        },
      },
      durableEffects: [
        'privacy_preference_upsert',
        'audit_event_append',
      ],
      enforcementConsequences: ['preference_enforced_immediately'],
      evidence: {
        auditEvent: 'privacy.preference_set',
        updatedAt: now + 3,
      },
      rollback: {
        supported: true,
        targetState: 'opted_out',
        boundary: 'separate_preference_change_confirmation_required',
      },
    });
    expect(setPrivacyPreference).toHaveBeenCalledTimes(1);
    expect(setPrivacyPreference).toHaveBeenLastCalledWith({
      canonicalUserId,
      preferenceType: 'memory_association',
      state: 'opted_in',
      expectedState: 'opted_out',
      expectedVersion: {
        source: 'stored_preference',
        updatedAt: now + 2,
      },
      reasonCode: 'governance_http_privacy_preference_change_confirmed',
    });
    expect(db.prepare(
      `SELECT state, reason, updated_by_user_id, updated_by_actor_class,
              updated_by_context, created_at, updated_at
         FROM privacy_preferences
        WHERE canonical_user_id = ? AND preference_type = ?`,
    ).get(canonicalUserId, 'memory_association')).toEqual({
      state: 'opted_in',
      reason: 'governance_http_privacy_preference_change_confirmed',
      updated_by_user_id: 'admin',
      updated_by_actor_class: 'admin',
      updated_by_context: 'admin_cli',
      created_at: now + 1,
      updated_at: now + 3,
    });
    const privacyPreferences = new PrivacyPreferenceRepository(db);
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'memory_association'))
      .toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get())
      .toBe(changesBeforeConfirmations + 2);
    for (const rawValue of [
      canonicalUserId,
      updaterUserId,
      platformId,
      secret,
      firstSessionDigest,
      privacyHandle,
      storedPreview.previewHandle,
    ]) {
      expect(storedConfirmationText).not.toContain(rawValue);
    }

    const repeatedConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify(storedConfirmationBody),
    });
    expect(repeatedConfirmation.status).toBe(409);
    expect(await repeatedConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(setPrivacyPreference).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT total_changes()').pluck().get())
      .toBe(changesBeforeConfirmations + 2);

    const implicitConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-Scope': implicitPrivacyHandle,
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: implicitPreview.previewHandle,
        preferenceType: 'proactive_dm',
        targetState: 'opted_out',
      }),
    });
    expect(implicitConfirmation.status).toBe(200);
    const implicitConfirmationText = await implicitConfirmation.text();
    const implicitConfirmationBody = JSON.parse(implicitConfirmationText) as {
      current: { version: { updatedAt: number } };
      evidence: { updatedAt: number };
    };
    expect(implicitConfirmationBody).toEqual({
      action: 'privacy.preference.change',
      outcome: 'updated',
      preferenceType: 'proactive_dm',
      current: {
        state: 'opted_out',
        version: {
          source: 'stored_preference',
          updatedAt: expect.any(Number),
        },
      },
      durableEffects: [
        'privacy_preference_upsert',
        'audit_event_append',
      ],
      enforcementConsequences: ['preference_enforced_immediately'],
      evidence: {
        auditEvent: 'privacy.preference_set',
        updatedAt: expect.any(Number),
      },
      rollback: {
        supported: true,
        targetState: 'opted_in',
        boundary: 'separate_preference_change_confirmation_required',
      },
    });
    expect(implicitConfirmationBody.current.version.updatedAt)
      .toBe(implicitConfirmationBody.evidence.updatedAt);
    expect(Number.isSafeInteger(implicitConfirmationBody.evidence.updatedAt)).toBe(true);
    expect(setPrivacyPreference).toHaveBeenCalledTimes(2);
    expect(setPrivacyPreference).toHaveBeenLastCalledWith({
      canonicalUserId: updaterUserId,
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      expectedState: 'opted_in',
      expectedVersion: {
        source: 'implicit_default',
        updatedAt: null,
      },
      reasonCode: 'governance_http_privacy_preference_change_confirmed',
    });
    expect(await privacyPreferences.isOptedOut(updaterUserId, 'proactive_dm')).toBe(true);
    expect(db.prepare(
      `SELECT state, reason, updated_by_user_id, updated_by_actor_class,
              updated_by_context, created_at, updated_at
         FROM privacy_preferences
        WHERE canonical_user_id = ? AND preference_type = ?`,
    ).get(updaterUserId, 'proactive_dm')).toEqual({
      state: 'opted_out',
      reason: 'governance_http_privacy_preference_change_confirmed',
      updated_by_user_id: 'admin',
      updated_by_actor_class: 'admin',
      updated_by_context: 'admin_cli',
      created_at: implicitConfirmationBody.evidence.updatedAt,
      updated_at: implicitConfirmationBody.evidence.updatedAt,
    });
    for (const rawValue of [
      canonicalUserId,
      updaterUserId,
      platformId,
      secret,
      firstSessionDigest,
      implicitPrivacyHandle,
      implicitPreview.previewHandle,
    ]) {
      expect(implicitConfirmationText).not.toContain(rawValue);
    }

    const auditRows = db.prepare(
      `SELECT timestamp, event_type, event_id, actor_user_id, actor_class,
              invocation_context, details
         FROM audit_log
        WHERE event_type = 'privacy.preference_set'
        ORDER BY timestamp ASC`,
    ).all() as Array<{
      timestamp: number;
      event_type: string;
      event_id: string;
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
    }>;
    expect(auditRows).toHaveLength(2);
    expect(auditRows.every((row) => (
      row.event_type === 'privacy.preference_set'
      && row.actor_user_id === 'admin'
      && row.actor_class === 'admin'
      && row.invocation_context === 'admin_cli'
      && row.details.includes('governance_http_privacy_preference_change_confirmed')
      && !row.details.includes(secret)
      && !row.details.includes(platformId)
    ))).toBe(true);

    const driftPreviewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        action: 'change',
        preferenceType: 'memory_association',
        targetState: 'opted_out',
      }),
    });
    expect(driftPreviewResponse.status).toBe(201);
    const driftPreview = await driftPreviewResponse.json() as typeof storedPreview;
    db.prepare(
      `UPDATE privacy_preferences
          SET updated_at = updated_at + 10
        WHERE canonical_user_id = ? AND preference_type = ?`,
    ).run(canonicalUserId, 'memory_association');
    const changesAfterDrift = db.prepare('SELECT total_changes()').pluck().get();
    const serviceCallsBeforeDriftConfirmation = setPrivacyPreference.mock.calls.length;
    const driftConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: driftPreview.previewHandle,
        preferenceType: 'memory_association',
        targetState: 'opted_out',
      }),
    });
    expect(driftConfirmation.status).toBe(409);
    expect(await driftConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(setPrivacyPreference).toHaveBeenCalledTimes(serviceCallsBeforeDriftConfirmation);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterDrift);

    const racePreviewResponse = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        action: 'change',
        preferenceType: 'memory_association',
        targetState: 'opted_out',
      }),
    });
    expect(racePreviewResponse.status).toBe(201);
    const racePreview = await racePreviewResponse.json() as typeof storedPreview;
    preferenceChangePreviewRead.mockImplementationOnce(async (input) => {
      const current = await originalPrivacyPreferenceChangePreviewRead.call(
        new GovernanceQueryService(db),
        input,
      );
      db.prepare(
        `UPDATE privacy_preferences
            SET updated_at = updated_at + 1
          WHERE canonical_user_id = ? AND preference_type = ?`,
      ).run(canonicalUserId, 'memory_association');
      return current;
    });
    const changesBeforeAtomicRace = db.prepare('SELECT total_changes()').pluck().get();
    const raceConfirmation = await fetch(`${origin}${confirmationPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: racePreview.previewHandle,
        preferenceType: 'memory_association',
        targetState: 'opted_out',
      }),
    });
    expect(raceConfirmation.status).toBe(409);
    expect(await raceConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(setPrivacyPreference).toHaveBeenCalledTimes(serviceCallsBeforeDriftConfirmation + 1);
    expect(setPrivacyPreference).toHaveBeenLastCalledWith({
      canonicalUserId,
      preferenceType: 'memory_association',
      state: 'opted_out',
      expectedState: 'opted_in',
      expectedVersion: {
        source: 'stored_preference',
        updatedAt: now + 13,
      },
      reasonCode: 'governance_http_privacy_preference_change_confirmed',
    });
    expect(db.prepare('SELECT total_changes()').pluck().get())
      .toBe(changesBeforeAtomicRace + 1);
    expect(db.prepare(
      `SELECT COUNT(*)
         FROM audit_log
        WHERE event_type = 'privacy.preference_set'`,
    ).pluck().get()).toBe(2);
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'memory_association'))
      .toBe(false);

    expect(db.prepare('SELECT total_changes()').pluck().get()).not.toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves the payload-free model-invocation Activity aggregate only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const summary = {
      generatedAt: new Date('2032-01-02T00:00:00.000Z'),
      filters: {},
      total: 2,
      byPurpose: { pi_turn: 2 },
      byStatus: { completed: 1, failed: 1 },
      completedKnownUsage: 1,
      completedUnknownUsage: 0,
      providerLatencyMs: { count: 1, sumMs: 12, maxMs: 12 },
    } satisfies ModelInvocationSummaryInspectionRecord;
    const summaryRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'summarizeModelInvocations',
    ).mockResolvedValue(summary);
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const origin = `http://127.0.0.1:${governancePort}`;
    const unauthenticated = await fetch(
      `${origin}${API_PREFIX}/activity/model-invocations`,
      { headers: { Connection: 'close' } },
    );
    expect(unauthenticated.status).toBe(401);
    expect(summaryRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = app.getDatabase().prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(
      `${origin}${API_PREFIX}/activity/model-invocations?status=completed`,
      { headers: { Connection: 'close', Cookie: session.cookie } },
    );
    expect(withQuery.status).toBe(400);
    expect(summaryRead).not.toHaveBeenCalled();

    const withScope = await fetch(
      `${origin}${API_PREFIX}/activity/model-invocations`,
      {
        headers: {
          Connection: 'close',
          Cookie: session.cookie,
          'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
        },
      },
    );
    expect(withScope.status).toBe(400);
    expect(summaryRead).not.toHaveBeenCalled();

    const response = await fetch(
      `${origin}${API_PREFIX}/activity/model-invocations`,
      { headers: { Connection: 'close', Cookie: session.cookie } },
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({
      ...summary,
      generatedAt: summary.generatedAt.toISOString(),
    });
    expect(summaryRead).toHaveBeenCalledTimes(1);
    expect(summaryRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain('prompt');
    expect(responseText).not.toContain('response');
    expect(responseText).not.toContain('invocation-id');

    const repeated = await fetch(
      `${origin}${API_PREFIX}/activity/model-invocations`,
      { headers: { Connection: 'close', Cookie: session.cookie } },
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(summaryRead).toHaveBeenCalledTimes(2);
    const changesAfterReads = app.getDatabase().prepare('SELECT total_changes()').pluck().get();
    expect(changesAfterReads).toBe(changesBeforeReads);
  });

  it('serves bounded worker-heartbeat Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '456789012';
    const detailsSecret = 'synthetic-worker-heartbeat-details-secret';
    const jobId = `job-http-heartbeat-${platformId}`;
    const workerId = `worker-http-heartbeat-${platformId}`;
    const workerType = `background-${platformId}`;
    const heartbeatAt = Date.parse('2032-01-03T00:00:00.000Z');
    const heartbeatRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listWorkerHeartbeats',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO jobs (
         id, type, payload, status, attempts, max_attempts,
         created_at, updated_at, scheduled_at
       ) VALUES (?, 'summary', '{}', 'running', 1, 3, ?, ?, ?)`,
    ).run(jobId, heartbeatAt, heartbeatAt, heartbeatAt);
    db.prepare(
      `INSERT INTO worker_heartbeats (
         worker_id, worker_type, status, current_job_id, heartbeat_at, details
       ) VALUES (?, ?, 'running', ?, ?, ?)`,
    ).run(
      workerId,
      workerType,
      jobId,
      heartbeatAt,
      JSON.stringify({ token: detailsSecret, senderId: Number(platformId) }),
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/worker-heartbeats`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(heartbeatRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includeDetails=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(heartbeatRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(heartbeatRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      workerId: 'worker-http-heartbeat-[REDACTED:platform_id]',
      workerType: 'background-[REDACTED:platform_id]',
      status: 'running',
      currentJobId: 'job-http-heartbeat-[REDACTED:platform_id]',
      heartbeatAt: new Date(heartbeatAt).toISOString(),
    }]);
    expect(heartbeatRead).toHaveBeenCalledTimes(1);
    expect(heartbeatRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(detailsSecret);
    expect(responseText).not.toContain('details');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(heartbeatRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded job Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '567890123';
    const payloadSecret = 'synthetic-job-activity-secret';
    const jobId = `job-http-activity-${platformId}`;
    const jobType = `summary-${platformId}`;
    const leaseOwner = `worker-${platformId}`;
    const createdAt = Date.parse('2032-01-04T00:00:00.000Z');
    const startedAt = createdAt + 1_000;
    const heartbeatAt = createdAt + 2_000;
    const updatedAt = createdAt + 3_000;
    const completedAt = createdAt + 4_000;
    const scheduledAt = createdAt + 5_000;
    const leaseExpiresAt = createdAt + 6_000;
    const jobRead = vi.spyOn(GovernanceQueryService.prototype, 'listJobs');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO jobs (
         id, type, payload, idempotency_key, status, attempts, max_attempts,
         lease_owner, lease_expires_at, heartbeat_at,
         created_at, updated_at, scheduled_at, started_at, completed_at,
         error, result
       ) VALUES (?, ?, ?, ?, 'failed', 2, 4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      jobType,
      JSON.stringify({ token: `token=${payloadSecret}`, userId: Number(platformId) }),
      `summary:${platformId}`,
      leaseOwner,
      leaseExpiresAt,
      heartbeatAt,
      createdAt,
      updatedAt,
      scheduledAt,
      startedAt,
      completedAt,
      `failure password=${payloadSecret}`,
      JSON.stringify({ password: payloadSecret, userId: Number(platformId) }),
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/jobs`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(jobRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includePayload=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(jobRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(jobRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'job-http-activity-[REDACTED:platform_id]',
      type: 'summary-[REDACTED:platform_id]',
      status: 'failed',
      attempts: 2,
      maxAttempts: 4,
      idempotencyKey: 'summary:[REDACTED:platform_id]',
      leaseOwner: 'worker-[REDACTED:platform_id]',
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      heartbeatAt: new Date(heartbeatAt).toISOString(),
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      scheduledAt: new Date(scheduledAt).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      error: 'failure [REDACTED:password_assignment]',
    }]);
    expect(jobRead).toHaveBeenCalledTimes(1);
    expect(jobRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(payloadSecret);
    expect(responseText).not.toContain('payload');
    expect(responseText).not.toContain('result');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(jobRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded job-attempt Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '901234567';
    const resultSecret = 'synthetic-job-attempt-activity-secret';
    const jobId = `job-http-attempt-activity-${platformId}`;
    const startedAt = Date.parse('2032-01-08T00:00:00.000Z');
    const heartbeatAt = startedAt + 1_000;
    const completedAt = startedAt + 2_000;
    const jobAttemptRead = vi.spyOn(GovernanceQueryService.prototype, 'listJobAttempts');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO jobs (
         id, type, payload, status, attempts, max_attempts,
         created_at, updated_at, scheduled_at, completed_at, error, result
       ) VALUES (?, 'summary', ?, 'failed', 2, 4, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      JSON.stringify({ password: resultSecret, userId: Number(platformId) }),
      startedAt,
      completedAt,
      startedAt,
      completedAt,
      `failure password=${resultSecret}`,
      JSON.stringify({ token: `token=${resultSecret}`, userId: Number(platformId) }),
    );
    db.prepare(
      `INSERT INTO job_attempts (
         id, job_id, attempt_number, worker_id, status,
         started_at, completed_at, heartbeat_at, error, result
       ) VALUES (?, ?, 2, ?, 'failed', ?, ?, ?, ?, ?)`,
    ).run(
      `attempt-http-activity-${platformId}`,
      jobId,
      `worker-${platformId}`,
      startedAt,
      completedAt,
      heartbeatAt,
      `attempt failure password=${resultSecret}`,
      JSON.stringify({ token: `token=${resultSecret}`, userId: Number(platformId) }),
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/job-attempts`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(jobAttemptRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includeResult=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(jobAttemptRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(jobAttemptRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'attempt-http-activity-[REDACTED:platform_id]',
      jobId: 'job-http-attempt-activity-[REDACTED:platform_id]',
      attemptNumber: 2,
      workerId: 'worker-[REDACTED:platform_id]',
      status: 'failed',
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      heartbeatAt: new Date(heartbeatAt).toISOString(),
      error: 'attempt failure [REDACTED:password_assignment]',
    }]);
    expect(jobAttemptRead).toHaveBeenCalledTimes(1);
    expect(jobAttemptRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(resultSecret);
    expect(responseText).not.toContain('result');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(jobAttemptRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded event-processing-failure Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '912345678';
    const detailSecret = 'synthetic-event-failure-activity-secret';
    const eventId = `event-http-failure-activity-${platformId}`;
    const turnId = `turn-http-failure-activity-${platformId}`;
    const occurredAt = Date.parse('2032-01-09T00:00:00.000Z');
    const errorMessageHash = 'a'.repeat(64);
    const messageIdHash = 'b'.repeat(64);
    const senderIdHash = 'c'.repeat(64);
    const conversationIdHash = 'd'.repeat(64);
    const failureRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listEventProcessingFailures',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      eventId,
      occurredAt,
      `private:${platformId}`,
      JSON.stringify({ password: detailSecret, userId: Number(platformId) }),
      occurredAt,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider,
         status, started_at, completed_at
       ) VALUES (?, ?, ?, 'mock', 'mock', 'failed', ?, ?)`,
    ).run(turnId, `private:${platformId}`, eventId, occurredAt, occurredAt + 1_000);
    db.prepare(
      `INSERT INTO event_processing_failures (
         id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
         error_name, error_message_hash, message_id_hash, sender_id_hash,
         conversation_id_hash, details
       ) VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?)`,
    ).run(
      `failure-http-activity-${platformId}`,
      eventId,
      turnId,
      occurredAt + 2_000,
      `provider-${platformId}`,
      `ProviderFailure-${platformId}-password=${detailSecret}`,
      errorMessageHash,
      messageIdHash,
      senderIdHash,
      conversationIdHash,
      JSON.stringify({ token: `token=${detailSecret}`, userId: Number(platformId) }),
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/event-processing-failures`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(failureRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includeDetails=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(failureRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(failureRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'failure-http-activity-[REDACTED:platform_id]',
      rawEventId: 'event-http-failure-activity-[REDACTED:platform_id]',
      turnId: 'turn-http-failure-activity-[REDACTED:platform_id]',
      occurredAt: new Date(occurredAt + 2_000).toISOString(),
      stage: 'provider-[REDACTED:platform_id]',
      conversationType: 'private',
      errorName: 'ProviderFailure-[REDACTED:platform_id]-[REDACTED:password_assignment]',
      errorMessageHash,
      messageIdHash,
      senderIdHash,
      conversationIdHash,
    }]);
    expect(failureRead).toHaveBeenCalledTimes(1);
    expect(failureRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(detailSecret);
    expect(responseText).not.toContain('details');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(failureRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded audit Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '923456789';
    const detailSecret = 'synthetic-audit-activity-secret';
    const timestamp = Date.parse('2032-01-10T00:00:00.000Z');
    const auditRead = vi.spyOn(GovernanceQueryService.prototype, 'listAudit');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO audit_log (
         id, timestamp, category, level, event_type, event_id,
         actor_user_id, actor_class, invocation_context,
         summary, details, redacted, risk_level, evaluator_decision_id
       ) VALUES (?, ?, 'tool', 'full', ?, ?, ?, 'admin', ?, ?, ?, 0, 'high', NULL)`,
    ).run(
      `audit-http-activity-${platformId}`,
      timestamp,
      `tool.execute_${platformId}`,
      `event-${platformId}`,
      `user-${platformId}`,
      `admin_cli_${platformId}`,
      `Audit password=${detailSecret}`,
      JSON.stringify({ token: `token=${detailSecret}`, userId: Number(platformId) }),
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/audit`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(auditRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includeDetails=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(auditRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(auditRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'audit-http-activity-[REDACTED:platform_id]',
      timestamp: new Date(timestamp).toISOString(),
      category: 'tool',
      level: 'full',
      eventType: 'tool.execute_[REDACTED:platform_id]',
      eventId: 'event-[REDACTED:platform_id]',
      actor: {
        canonicalUserId: 'user-[REDACTED:platform_id]',
        actorClass: 'admin',
        context: 'admin_cli_[REDACTED:platform_id]',
      },
      summary: 'Audit [REDACTED:password_assignment]',
      detailsRedacted: true,
      redacted: true,
      riskLevel: 'high',
    }]);
    expect(auditRead).toHaveBeenCalledTimes(1);
    expect(auditRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(detailSecret);
    expect(responseText).not.toContain('"details"');
    expect(responseText).not.toContain('evaluatorDecisionId');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(auditRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded tool-call Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '678901234';
    const payloadSecret = 'synthetic-tool-activity-secret';
    const eventId = `event-http-tool-activity-${platformId}`;
    const turnId = `turn-http-tool-activity-${platformId}`;
    const createdAt = Date.parse('2032-01-05T00:00:00.000Z');
    const toolCallRead = vi.spyOn(GovernanceQueryService.prototype, 'listToolCalls');
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      eventId,
      createdAt,
      `private:${platformId}`,
      JSON.stringify({ password: payloadSecret, userId: Number(platformId) }),
      createdAt,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider,
         status, started_at, completed_at
       ) VALUES (?, ?, ?, 'mock', 'mock', 'completed', ?, ?)`,
    ).run(turnId, `private:${platformId}`, eventId, createdAt, createdAt + 1_000);
    db.prepare(
      `INSERT INTO tool_calls (
         id, turn_id, tool_name, input, output, requested_by,
         actor_user_id, actor_class, invocation_context, status,
         error_code, error_message, execution_time_ms, secrets_redacted, created_at
       ) VALUES (?, ?, ?, ?, ?, 'pi', ?, 'user', 'private_chat', 'error', ?, ?, 17, 1, ?)`,
    ).run(
      `tool-http-activity-${platformId}`,
      turnId,
      `workspace.read_${platformId}`,
      JSON.stringify({ token: `token=${payloadSecret}`, userId: Number(platformId) }),
      JSON.stringify({ password: payloadSecret, userId: Number(platformId) }),
      `user-${platformId}`,
      `tool-error-${platformId}`,
      `failure password=${payloadSecret}`,
      createdAt + 2_000,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/tool-calls`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(toolCallRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includePayload=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(toolCallRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(toolCallRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'tool-http-activity-[REDACTED:platform_id]',
      turnId: 'turn-http-tool-activity-[REDACTED:platform_id]',
      toolName: 'workspace.read_[REDACTED:platform_id]',
      requestedBy: 'pi',
      actor: {
        canonicalUserId: 'user-[REDACTED:platform_id]',
        actorClass: 'user',
      },
      context: 'private_chat',
      status: 'error',
      errorCode: 'tool-error-[REDACTED:platform_id]',
      errorMessage: 'failure [REDACTED:password_assignment]',
      executionTimeMs: 17,
      secretsRedacted: true,
      createdAt: new Date(createdAt + 2_000).toISOString(),
    }]);
    expect(toolCallRead).toHaveBeenCalledTimes(1);
    expect(toolCallRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(payloadSecret);
    expect(responseText).not.toContain('input');
    expect(responseText).not.toContain('output');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(toolCallRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded action-decision Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '789012345';
    const actionSecret = 'synthetic-action-activity-secret';
    const eventId = `event-http-action-activity-${platformId}`;
    const turnId = `turn-http-action-activity-${platformId}`;
    const createdAt = Date.parse('2032-01-06T00:00:00.000Z');
    const actionDecisionRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listActionDecisions',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      eventId,
      createdAt,
      `private:${platformId}`,
      JSON.stringify({ password: actionSecret, userId: Number(platformId) }),
      createdAt,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider,
         status, started_at, completed_at
       ) VALUES (?, ?, ?, 'mock', 'mock', 'completed', ?, ?)`,
    ).run(turnId, `private:${platformId}`, eventId, createdAt, createdAt + 1_000);
    db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, 'evaluator', 'high', 0.75, 1, NULL, ?, ?, ?, ?)`,
    ).run(
      `decision-http-activity-${platformId}`,
      turnId,
      JSON.stringify([{
        type: 'reply_full',
        target: { conversationId: `private:${platformId}`, userId: platformId },
        payload: { text: `password=${actionSecret}` },
        reason: `token=${actionSecret}`,
      }]),
      JSON.stringify([`reason password=${actionSecret}`]),
      JSON.stringify([`suppressor token=${actionSecret}`]),
      createdAt + 2_000,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/action-decisions`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(actionDecisionRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includeActions=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(actionDecisionRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(actionDecisionRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'decision-http-activity-[REDACTED:platform_id]',
      turnId: 'turn-http-action-activity-[REDACTED:platform_id]',
      createdAt: new Date(createdAt + 2_000).toISOString(),
      decidedBy: 'evaluator',
      riskLevel: 'high',
      confidence: 0.75,
      evaluatorRequired: true,
      actionCount: 1,
      reasons: ['reason [REDACTED:password_assignment]'],
      suppressors: ['suppressor [REDACTED:token_assignment]'],
    }]);
    expect(actionDecisionRead).toHaveBeenCalledTimes(1);
    expect(actionDecisionRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(actionSecret);
    expect(responseText).not.toContain('"actions"');
    expect(responseText).not.toContain('evaluatorPassed');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(actionDecisionRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded action-execution Activity records only to an authenticated session', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const platformId = '890123456';
    const executionSecret = 'synthetic-execution-activity-secret';
    const eventId = `event-http-execution-activity-${platformId}`;
    const turnId = `turn-http-execution-activity-${platformId}`;
    const decisionId = `decision-http-execution-activity-${platformId}`;
    const createdAt = Date.parse('2032-01-07T00:00:00.000Z');
    const actionExecutionRead = vi.spyOn(
      GovernanceQueryService.prototype,
      'listActionExecutions',
    );
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);

    await app.start();
    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      eventId,
      createdAt,
      `private:${platformId}`,
      JSON.stringify({ password: executionSecret, userId: Number(platformId) }),
      createdAt,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider,
         status, started_at, completed_at
       ) VALUES (?, ?, ?, 'mock', 'mock', 'completed', ?, ?)`,
    ).run(turnId, `private:${platformId}`, eventId, createdAt, createdAt + 1_000);
    db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, 'evaluator', 'high', 0.75, 1, 1, '[]', NULL, NULL, ?)`,
    ).run(decisionId, turnId, createdAt + 2_000);
    db.prepare(
      `INSERT INTO action_executions (
         id, action_decision_id, action_type, status,
         executed_message_id, executed_memory_id, executed_job_id,
         downgraded_from, downgraded_reason, error_code, error_message,
         audit_level, audit_entry, executed_at
       ) VALUES (?, ?, 'reply_full', 'failed', ?, NULL, NULL, 'reply_short', ?, ?, ?, 'full', ?, ?)`,
    ).run(
      `execution-http-activity-${platformId}`,
      decisionId,
      `message-${platformId}`,
      `reason password=${executionSecret}`,
      `execution-error-${platformId}`,
      `failure token=${executionSecret}`,
      `audit password=${executionSecret} target=${platformId}`,
      createdAt + 3_000,
    );

    const origin = `http://127.0.0.1:${governancePort}`;
    const path = `${API_PREFIX}/activity/action-executions`;
    const unauthenticated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(actionExecutionRead).not.toHaveBeenCalled();

    const session = await loginGovernance(origin);
    const changesBeforeReads = db.prepare('SELECT total_changes()').pluck().get();
    const withQuery = await fetch(`${origin}${path}?includeAuditEntry=true`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(withQuery.status).toBe(400);
    expect(actionExecutionRead).not.toHaveBeenCalled();

    const withScope = await fetch(`${origin}${path}`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': 'scope-handle-should-be-rejected',
      },
    });
    expect(withScope.status).toBe(400);
    expect(actionExecutionRead).not.toHaveBeenCalled();

    const response = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual([{
      id: 'execution-http-activity-[REDACTED:platform_id]',
      actionDecisionId: 'decision-http-execution-activity-[REDACTED:platform_id]',
      actionType: 'reply_full',
      status: 'failed',
      executedMessageId: 'message-[REDACTED:platform_id]',
      downgradedFrom: 'reply_short',
      downgradedReason: 'reason [REDACTED:password_assignment]',
      errorCode: 'execution-error-[REDACTED:platform_id]',
      errorMessage: 'failure [REDACTED:token_assignment]',
      auditLevel: 'full',
      executedAt: new Date(createdAt + 3_000).toISOString(),
    }]);
    expect(actionExecutionRead).toHaveBeenCalledTimes(1);
    expect(actionExecutionRead).toHaveBeenCalledWith();
    expect(responseText).not.toContain(platformId);
    expect(responseText).not.toContain(executionSecret);
    expect(responseText).not.toContain('executedMemoryId');
    expect(responseText).not.toContain('executedJobId');
    expect(responseText).not.toContain('auditEntry');

    const repeated = await fetch(`${origin}${path}`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(responseText);
    expect(actionExecutionRead).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('serves bounded maintenance-review reads and previews both review actions before approval', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const memoryId = 'synthetic-http-review-memory-123456789';
    const sourceId = 'synthetic-http-review-source-987654321';
    const privateContent = 'synthetic-private-review-content';
    const nowMs = Date.parse('2032-01-02T00:00:00.000Z');
    new MemoryRepository(app.getDatabase()).createSync({
      id: memoryId,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic HTTP review fixture',
      content: privateContent,
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId,
        sourceTimestamp: nowMs - 1,
        extractedBy: 'admin',
        external: true,
      }],
      actor: { actorClass: 'admin', context: 'admin_cli' },
    });
    const proposal = await createMemoryMaintenanceProposal(
      app.getDatabase(),
      new AuditRepository(app.getDatabase()),
      {
        kind: 'decay',
        candidateMemoryIds: [memoryId],
        reasonCodes: ['stale'],
        proposedEffect: { type: 'disable', memoryId },
        nowMs,
      },
    );
    const issuePreviewHandle = vi.spyOn(GovernancePreviewHandleRegistry.prototype, 'issue');
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const reviewProposal = vi.spyOn(
      GovernanceService.prototype,
      'reviewMemoryMaintenanceProposal',
    );
    const applyProposal = vi.spyOn(
      GovernanceService.prototype,
      'applyMemoryMaintenanceProposal',
    );
    const rollbackProposal = vi.spyOn(
      GovernanceService.prototype,
      'rollbackMemoryMaintenanceProposal',
    );

    await app.start();
    const origin = `http://127.0.0.1:${governancePort}`;
    const firstSession = await loginGovernance(origin);
    const firstCookie = firstSession.cookie;
    const scopeResponse = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: firstCookie },
    });
    expect(scopeResponse.status).toBe(200);
    const scopeCatalog = await scopeResponse.json() as {
      entries: Array<{ scopeKind: string; handle: string }>;
    };
    const systemScope = scopeCatalog.entries.find((entry) => entry.scopeKind === 'system');
    expect(systemScope?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const changesBeforeReads = app.getDatabase().prepare('SELECT total_changes()').pluck().get();

    const unauthenticated = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: { Connection: 'close' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe(JSON.stringify({ error: 'unauthorized' }));

    const missingScope = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: { Connection: 'close', Cookie: firstCookie },
    });
    expect(missingScope.status).toBe(400);
    expect(await missingScope.text()).toBe(JSON.stringify({ error: 'bad_request' }));

    const withQuery = await fetch(`${origin}${API_PREFIX}/memory-reviews?state=all`, {
      headers: {
        Connection: 'close',
        Cookie: firstCookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(withQuery.status).toBe(400);

    const listed = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: firstCookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    const listedBody = JSON.parse(listedText) as {
      entries: Array<Record<string, unknown> & { handle: string; handleExpiresAt: number }>;
      truncated: boolean;
    };
    expect(listedBody.entries).toHaveLength(1);
    expect(listedBody.truncated).toBe(false);
    expect(listedBody.entries[0]).toMatchObject({
      kind: 'decay',
      effectType: 'disable',
      lifecycleState: 'pending_review',
      scopeKind: 'system',
      confidence: 0.4,
      candidateCount: 1,
      reasonCodes: ['stale'],
      revisionCount: 1,
      currentRevisionNumber: 1,
    });
    expect(listedBody.entries[0]?.proposalRef).toMatch(/^[0-9a-f]{16}$/u);
    expect(listedBody.entries[0]?.candidateFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(listedBody.entries[0]?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Number.isSafeInteger(listedBody.entries[0]?.handleExpiresAt)).toBe(true);
    expect(Number.isNaN(Date.parse(String(listedBody.entries[0]?.createdAt)))).toBe(false);
    expect(Number.isNaN(Date.parse(String(listedBody.entries[0]?.updatedAt)))).toBe(false);
    expect(Object.keys(listedBody.entries[0] ?? {}).sort()).toEqual([
      'candidateCount',
      'candidateFingerprint',
      'confidence',
      'createdAt',
      'currentRevisionNumber',
      'effectType',
      'handle',
      'handleExpiresAt',
      'kind',
      'lifecycleState',
      'proposalRef',
      'reasonCodes',
      'revisionCount',
      'scopeKind',
      'updatedAt',
    ]);
    expect(listedText).not.toContain(memoryId);
    expect(listedText).not.toContain(sourceId);
    expect(listedText).not.toContain(privateContent);
    expect(listedText).not.toContain(proposal.proposalId);

    const resourceHandle = listedBody.entries[0]?.handle ?? '';
    const repeatedList = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: firstCookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(repeatedList.status).toBe(200);
    const repeatedListBody = await repeatedList.json() as {
      entries: Array<{ handle: string }>;
    };
    expect(repeatedListBody.entries[0]?.handle).toBe(resourceHandle);

    const detailPath = `${API_PREFIX}/memory-reviews/${resourceHandle}`;
    const detail = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: firstCookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    const detailBody = JSON.parse(detailText) as Record<string, unknown> & {
      candidates: Array<Record<string, unknown>>;
      revisions: Array<Record<string, unknown>>;
    };
    expect(detailBody).toMatchObject({
      proposalRef: listedBody.entries[0]?.proposalRef,
      kind: 'decay',
      effectType: 'disable',
      lifecycleState: 'pending_review',
      scopeKind: 'system',
      candidateCount: 1,
      candidatesTruncated: false,
      revisionsTruncated: false,
      effectMemoryRole: 'disable_target',
    });
    expect(detailBody.effectMemoryRef).toMatch(/^[0-9a-f]{16}$/u);
    expect(detailBody.candidates).toHaveLength(1);
    expect(detailBody.candidates[0]?.memoryRef).toMatch(/^[0-9a-f]{16}$/u);
    expect(detailBody.revisions).toHaveLength(1);
    expect(detailText).not.toContain(memoryId);
    expect(detailText).not.toContain(sourceId);
    expect(detailText).not.toContain(privateContent);
    expect(detailText).not.toContain(proposal.proposalId);

    const previewHeaders = {
      Connection: 'close',
      Cookie: firstCookie,
      Origin: origin,
      'X-LetheBot-CSRF': firstSession.csrfToken,
      'X-LetheBot-Scope': systemScope?.handle ?? '',
      'Content-Type': 'application/json',
    };
    const unauthenticatedPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(unauthenticatedPreview.status).toBe(401);
    const missingCsrfPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': '',
      },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(missingCsrfPreview.status).toBe(403);
    for (const body of [
      {},
      { action: 'expire', reason: 'caller-controlled' },
      { action: 'approve', proposalId: proposal.proposalId },
    ]) {
      const invalidBodyPreview = await fetch(`${origin}${detailPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBodyPreview.status).toBe(400);
      expect(await invalidBodyPreview.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    const queryPreview = await fetch(`${origin}${detailPath}?confirm=true`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(queryPreview.status).toBe(400);
    expect(issuePreviewHandle).not.toHaveBeenCalled();

    const previewResponse = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(previewResponse.status).toBe(201);
    const previewText = await previewResponse.text();
    const previewBody = JSON.parse(previewText) as Record<string, unknown> & {
      previewHandle: string;
      previewExpiresAt: number;
      previewDigest: string;
    };
    expect(previewBody).toMatchObject({
      action: 'memory.maintenance.review.approve',
      scope: {
        scopeKind: 'system',
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      proposalKind: 'decay',
      proposalRef: listedBody.entries[0]?.proposalRef,
      proposedEffect: 'disable',
      affectedRecords: {
        count: 1,
        fingerprint: listedBody.entries[0]?.candidateFingerprint,
      },
      current: {
        lifecycleState: 'pending_review',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'approved',
        revisionNumber: 2,
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
    });
    expect(previewBody.previewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(previewBody.previewDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Number.isSafeInteger(previewBody.previewExpiresAt)).toBe(true);
    expect(Object.keys(previewBody).sort()).toEqual([
      'action',
      'affectedRecords',
      'current',
      'expected',
      'previewDigest',
      'previewExpiresAt',
      'previewHandle',
      'proposalKind',
      'proposalRef',
      'proposedEffect',
      'rollback',
      'scope',
    ]);
    expect(previewText).not.toContain(memoryId);
    expect(previewText).not.toContain(sourceId);
    expect(previewText).not.toContain(privateContent);
    expect(previewText).not.toContain(proposal.proposalId);
    expect(issuePreviewHandle).toHaveBeenCalledWith({
      sessionId: digestSessionCookie(firstCookie),
      sessionExpiresAt: expect.any(Number),
      actor: { kind: 'local_admin' },
      action: 'memory.maintenance.review.approve',
      resourceKind: 'memory_maintenance_review',
      resourceId: proposal.proposalId,
      scope: { kind: 'system' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      previewDigest: previewBody.previewDigest,
    });

    const repeatedPreviewResponse = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(repeatedPreviewResponse.status).toBe(201);
    const repeatedPreview = await repeatedPreviewResponse.json() as typeof previewBody;
    expect(repeatedPreview.previewHandle).not.toBe(previewBody.previewHandle);
    expect(repeatedPreview.previewDigest).toBe(previewBody.previewDigest);

    const rejectionPreviewResponse = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(rejectionPreviewResponse.status).toBe(201);
    const rejectionPreviewText = await rejectionPreviewResponse.text();
    const rejectionPreview = JSON.parse(rejectionPreviewText) as typeof previewBody;
    expect(rejectionPreview).toMatchObject({
      action: 'memory.maintenance.review.reject',
      scope: {
        scopeKind: 'system',
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      proposalKind: 'decay',
      proposalRef: listedBody.entries[0]?.proposalRef,
      proposedEffect: 'disable',
      affectedRecords: {
        count: 1,
        fingerprint: listedBody.entries[0]?.candidateFingerprint,
      },
      current: {
        lifecycleState: 'pending_review',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'rejected',
        revisionNumber: 2,
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
    });
    expect(rejectionPreview.scope).toEqual(previewBody.scope);
    expect(rejectionPreview.previewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(rejectionPreview.previewHandle).not.toBe(previewBody.previewHandle);
    expect(rejectionPreview.previewHandle).not.toBe(repeatedPreview.previewHandle);
    expect(rejectionPreview.previewDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(rejectionPreview.previewDigest).not.toBe(previewBody.previewDigest);
    expect(Number.isSafeInteger(rejectionPreview.previewExpiresAt)).toBe(true);
    expect(Object.keys(rejectionPreview).sort()).toEqual(Object.keys(previewBody).sort());
    expect(rejectionPreviewText).not.toContain(memoryId);
    expect(rejectionPreviewText).not.toContain(sourceId);
    expect(rejectionPreviewText).not.toContain(privateContent);
    expect(rejectionPreviewText).not.toContain(proposal.proposalId);
    expect(issuePreviewHandle).toHaveBeenNthCalledWith(3, {
      sessionId: digestSessionCookie(firstCookie),
      sessionExpiresAt: expect.any(Number),
      actor: { kind: 'local_admin' },
      action: 'memory.maintenance.review.reject',
      resourceKind: 'memory_maintenance_review',
      resourceId: proposal.proposalId,
      scope: { kind: 'system' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      previewDigest: rejectionPreview.previewDigest,
    });

    const expirationPreviewResponse = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'expire' }),
    });
    expect(expirationPreviewResponse.status).toBe(201);
    const expirationPreviewText = await expirationPreviewResponse.text();
    const expirationPreview = JSON.parse(expirationPreviewText) as typeof previewBody;
    expect(expirationPreview).toMatchObject({
      action: 'memory.maintenance.review.expire',
      scope: {
        scopeKind: 'system',
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      proposalKind: 'decay',
      proposalRef: listedBody.entries[0]?.proposalRef,
      proposedEffect: 'disable',
      affectedRecords: {
        count: 1,
        fingerprint: listedBody.entries[0]?.candidateFingerprint,
      },
      current: {
        lifecycleState: 'pending_review',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'expired',
        revisionNumber: 2,
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
    });
    expect(expirationPreview.scope).toEqual(previewBody.scope);
    expect(expirationPreview.previewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(expirationPreview.previewHandle).not.toBe(previewBody.previewHandle);
    expect(expirationPreview.previewHandle).not.toBe(repeatedPreview.previewHandle);
    expect(expirationPreview.previewHandle).not.toBe(rejectionPreview.previewHandle);
    expect(expirationPreview.previewDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(expirationPreview.previewDigest).not.toBe(previewBody.previewDigest);
    expect(expirationPreview.previewDigest).not.toBe(rejectionPreview.previewDigest);
    expect(Number.isSafeInteger(expirationPreview.previewExpiresAt)).toBe(true);
    expect(Object.keys(expirationPreview).sort()).toEqual(Object.keys(previewBody).sort());
    expect(expirationPreviewText).not.toContain(memoryId);
    expect(expirationPreviewText).not.toContain(sourceId);
    expect(expirationPreviewText).not.toContain(privateContent);
    expect(expirationPreviewText).not.toContain(proposal.proposalId);
    expect(issuePreviewHandle).toHaveBeenNthCalledWith(4, {
      sessionId: digestSessionCookie(firstCookie),
      sessionExpiresAt: expect.any(Number),
      actor: { kind: 'local_admin' },
      action: 'memory.maintenance.review.expire',
      resourceKind: 'memory_maintenance_review',
      resourceId: proposal.proposalId,
      scope: { kind: 'system' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      previewDigest: expirationPreview.previewDigest,
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(4);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(reviewProposal).not.toHaveBeenCalled();
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposal.proposalId)).toEqual({
      lifecycle_state: 'pending_review',
      current_revision_number: 1,
    });
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);
    const memoryRecordBefore = app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(memoryId);
    const memoryRevisionCountBefore = app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(memoryId);
    const approvalAuditCountBefore = app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.approved' AND event_id = ?`,
    ).pluck().get(proposal.proposalId) as number;

    const confirmPath = `${detailPath}/confirm`;
    const unauthenticatedConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(unauthenticatedConfirmation.status).toBe(401);
    expect(await unauthenticatedConfirmation.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    const missingCsrfConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        ...previewHeaders,
        'X-LetheBot-CSRF': '',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(missingCsrfConfirmation.status).toBe(403);
    for (const body of [
      {},
      { confirm: false, previewHandle: previewBody.previewHandle },
      { confirm: true },
      { confirm: true, previewHandle: 'short' },
      { confirm: true, previewHandle: previewBody.previewHandle, action: 'approve' },
    ]) {
      const invalidBodyConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidBodyConfirmation.status).toBe(400);
      expect(await invalidBodyConfirmation.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    const queryConfirmation = await fetch(`${origin}${confirmPath}?include=raw`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(queryConfirmation.status).toBe(400);
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);

    const unknownPreviewConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: 'z'.repeat(43),
      }),
    });
    expect(unknownPreviewConfirmation.status).toBe(404);
    expect(await unknownPreviewConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(reviewProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReads);

    const confirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: previewBody.previewHandle,
      }),
    });
    expect(confirmation.status).toBe(200);
    const confirmationText = await confirmation.text();
    const confirmationBody = JSON.parse(confirmationText) as Record<string, unknown>;
    expect(confirmationBody).toMatchObject({
      action: 'memory.maintenance.review.approve',
      outcome: 'approved',
      proposalRef: previewBody.proposalRef,
      current: {
        lifecycleState: 'approved',
        revisionNumber: 2,
      },
      evidence: {
        transition: 'approve',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'approval_does_not_apply_memory_effects',
      },
    });
    expect(Object.keys(confirmationBody).sort()).toEqual([
      'action',
      'current',
      'evidence',
      'memoryRecordMutation',
      'outcome',
      'proposalRef',
      'rollback',
    ]);
    expect(confirmationText).not.toContain(memoryId);
    expect(confirmationText).not.toContain(sourceId);
    expect(confirmationText).not.toContain(privateContent);
    expect(confirmationText).not.toContain(proposal.proposalId);
    expect(reviewProposal).toHaveBeenCalledTimes(1);
    expect(reviewProposal).toHaveBeenCalledWith({
      authority: { kind: 'local_admin' },
      proposalId: proposal.proposalId,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      reasonCode: 'governance_http_approval_confirmed',
    });
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposal.proposalId)).toEqual({
      lifecycle_state: 'approved',
      current_revision_number: 2,
    });
    expect(app.getDatabase().prepare(
      `SELECT revision_number AS revisionNumber,
              transition,
              previous_state AS previousState,
              new_state AS newState,
              actor_class AS actorClass,
              invocation_context AS invocationContext,
              reason_code AS reasonCode
         FROM memory_maintenance_proposal_revisions
        WHERE proposal_id = ?
        ORDER BY revision_number`,
    ).all(proposal.proposalId)).toEqual([
      expect.objectContaining({
        revisionNumber: 1,
        transition: 'propose',
        previousState: null,
        newState: 'pending_review',
      }),
      {
        revisionNumber: 2,
        transition: 'approve',
        previousState: 'pending_review',
        newState: 'approved',
        actorClass: 'admin',
        invocationContext: 'admin_cli',
        reasonCode: 'governance_http_approval_confirmed',
      },
    ]);
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.approved' AND event_id = ?`,
    ).pluck().get(proposal.proposalId)).toBe(approvalAuditCountBefore + 1);
    expect(app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(memoryId)).toEqual(memoryRecordBefore);
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(memoryId)).toBe(memoryRevisionCountBefore);

    for (const previewHandle of [previewBody.previewHandle, repeatedPreview.previewHandle]) {
      const staleOrConsumedConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle,
        }),
      });
      expect(staleOrConsumedConfirmation.status).toBe(409);
      expect(await staleOrConsumedConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    }
    expect(reviewProposal).toHaveBeenCalledTimes(1);
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_maintenance_proposal_revisions WHERE proposal_id = ?',
    ).pluck().get(proposal.proposalId)).toBe(2);
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.approved' AND event_id = ?`,
    ).pluck().get(proposal.proposalId)).toBe(approvalAuditCountBefore + 1);

    const nonPendingRejectionPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(nonPendingRejectionPreview.status).toBe(404);
    expect(await nonPendingRejectionPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const nonPendingExpirationPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'expire' }),
    });
    expect(nonPendingExpirationPreview.status).toBe(404);
    expect(await nonPendingExpirationPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(issuePreviewHandle).toHaveBeenCalledTimes(4);
    expect(reviewProposal).toHaveBeenCalledTimes(1);
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    const changesAfterConfirmation = app.getDatabase().prepare('SELECT total_changes()').pluck().get();

    const missingDetailScope = await fetch(`${origin}${detailPath}`, {
      headers: { Connection: 'close', Cookie: firstCookie },
    });
    expect(missingDetailScope.status).toBe(400);
    const rawProposalPath = await fetch(
      `${origin}${API_PREFIX}/memory-reviews/${encodeURIComponent(proposal.proposalId)}`,
      {
        headers: {
          Connection: 'close',
          Cookie: firstCookie,
          'X-LetheBot-Scope': systemScope?.handle ?? '',
        },
      },
    );
    expect(rawProposalPath.status).toBe(400);
    const unknownResource = await fetch(
      `${origin}${API_PREFIX}/memory-reviews/${'z'.repeat(43)}`,
      {
        headers: {
          Connection: 'close',
          Cookie: firstCookie,
          'X-LetheBot-Scope': systemScope?.handle ?? '',
        },
      },
    );
    expect(unknownResource.status).toBe(404);
    expect(await unknownResource.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const detailWithQuery = await fetch(`${origin}${detailPath}?include=raw`, {
      headers: {
        Connection: 'close',
        Cookie: firstCookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(detailWithQuery.status).toBe(400);

    const secondSession = await loginGovernance(origin);
    const secondCookie = secondSession.cookie;
    const secondScopeResponse = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: secondCookie },
    });
    expect(secondScopeResponse.status).toBe(200);
    const secondScopeCatalog = await secondScopeResponse.json() as {
      entries: Array<{ scopeKind: string; handle: string }>;
    };
    const secondSystemScope = secondScopeCatalog.entries.find(
      (entry) => entry.scopeKind === 'system',
    );
    const crossSession = await fetch(`${origin}${detailPath}`, {
      headers: {
        Connection: 'close',
        Cookie: secondCookie,
        'X-LetheBot-Scope': secondSystemScope?.handle ?? '',
      },
    });
    expect(crossSession.status).toBe(404);
    expect(await crossSession.text()).toBe(JSON.stringify({ error: 'not_found' }));
    const crossSessionPreview = await fetch(`${origin}${detailPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: secondCookie,
        Origin: origin,
        'X-LetheBot-CSRF': secondSession.csrfToken,
        'X-LetheBot-Scope': secondSystemScope?.handle ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(crossSessionPreview.status).toBe(404);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(4);
    const crossSessionConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Cookie: secondCookie,
        Origin: origin,
        'X-LetheBot-CSRF': secondSession.csrfToken,
        'X-LetheBot-Scope': secondSystemScope?.handle ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        confirm: true,
        previewHandle: repeatedPreview.previewHandle,
      }),
    });
    expect(crossSessionConfirmation.status).toBe(404);
    expect(await crossSessionConfirmation.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposal.proposalId)).toEqual({
      lifecycle_state: 'approved',
      current_revision_number: 2,
    });
    expect(reviewProposal).toHaveBeenCalledTimes(1);
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(memoryId)).toEqual(memoryRecordBefore);
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(memoryId)).toBe(memoryRevisionCountBefore);
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterConfirmation);

    const expirationMemoryId = 'synthetic-http-expiration-memory-246813579';
    const expirationSourceId = 'synthetic-http-expiration-source-975318642';
    const expirationContent = 'synthetic-private-expiration-content';
    const expirationMemories = new MemoryRepository(app.getDatabase());
    expirationMemories.createSync({
      id: expirationMemoryId,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic HTTP expiration fixture',
      content: expirationContent,
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId: expirationSourceId,
        sourceTimestamp: nowMs + 99,
        extractedBy: 'admin',
        external: true,
      }],
      actor: { actorClass: 'admin', context: 'admin_cli' },
    });
    const expirationProposal = await createMemoryMaintenanceProposal(
      app.getDatabase(),
      new AuditRepository(app.getDatabase()),
      {
        kind: 'decay',
        candidateMemoryIds: [expirationMemoryId],
        reasonCodes: ['stale'],
        proposedEffect: { type: 'disable', memoryId: expirationMemoryId },
        nowMs: nowMs + 100,
      },
    );
    const expirationMemoryBefore = app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(expirationMemoryId);
    const expirationMemoryRevisionCountBefore = app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(expirationMemoryId);
    const expirationAuditCountBefore = app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.expired' AND event_id = ?`,
    ).pluck().get(expirationProposal.proposalId) as number;
    expect((await expirationMemories.retrieve({ state: 'active', limit: 20 }))
      .map((memory) => memory.id)).toContain(expirationMemoryId);

    const expirationListResponse = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: firstCookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(expirationListResponse.status).toBe(200);
    const expirationList = await expirationListResponse.json() as {
      entries: Array<{
        handle: string;
        lifecycleState: string;
        proposalRef: string;
      }>;
    };
    const expirationResource = expirationList.entries.find(
      (entry) => entry.lifecycleState === 'pending_review',
    );
    expect(expirationResource?.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const expirationDetailPath = `${API_PREFIX}/memory-reviews/${expirationResource?.handle ?? ''}`;
    const currentExpirationPreviewResponse = await fetch(`${origin}${expirationDetailPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({ action: 'expire' }),
    });
    expect(currentExpirationPreviewResponse.status).toBe(201);
    const currentExpirationPreviewText = await currentExpirationPreviewResponse.text();
    const currentExpirationPreview = JSON.parse(currentExpirationPreviewText) as {
      previewHandle: string;
      previewDigest: string;
      proposalRef: string;
    };
    expect(currentExpirationPreview).toMatchObject({
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      proposalRef: expirationResource?.proposalRef,
    });
    expect(issuePreviewHandle).toHaveBeenCalledTimes(5);

    const malformedExpirationConfirmation = await fetch(
      `${origin}${expirationDetailPath}/confirm`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: currentExpirationPreview.previewHandle,
          action: 'expire',
          reason: 'caller-controlled',
        }),
      },
    );
    expect(malformedExpirationConfirmation.status).toBe(400);
    const crossActionExpirationConfirmation = await fetch(
      `${origin}${expirationDetailPath}/confirm`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: currentExpirationPreview.previewHandle,
          action: 'reject',
        }),
      },
    );
    expect(crossActionExpirationConfirmation.status).toBe(404);
    expect(await crossActionExpirationConfirmation.text())
      .toBe(JSON.stringify({ error: 'not_found' }));
    expect(reviewProposal).toHaveBeenCalledTimes(1);

    const staleExpirationConfirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: expirationPreview.previewHandle,
        action: 'expire',
      }),
    });
    expect(staleExpirationConfirmation.status).toBe(409);
    expect(await staleExpirationConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(reviewProposal).toHaveBeenCalledTimes(1);

    const expirationConfirmation = await fetch(`${origin}${expirationDetailPath}/confirm`, {
      method: 'POST',
      headers: previewHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: currentExpirationPreview.previewHandle,
        action: 'expire',
      }),
    });
    expect(expirationConfirmation.status).toBe(200);
    const expirationConfirmationText = await expirationConfirmation.text();
    const expirationConfirmationBody = JSON.parse(expirationConfirmationText) as Record<
      string,
      unknown
    >;
    expect(expirationConfirmationBody).toMatchObject({
      action: 'memory.maintenance.review.expire',
      outcome: 'expired',
      proposalRef: currentExpirationPreview.proposalRef,
      current: {
        lifecycleState: 'expired',
        revisionNumber: 2,
      },
      evidence: {
        transition: 'expire',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'expiration_does_not_apply_memory_effects',
      },
    });
    expect(Object.keys(expirationConfirmationBody).sort()).toEqual([
      'action',
      'current',
      'evidence',
      'memoryRecordMutation',
      'outcome',
      'proposalRef',
      'rollback',
    ]);
    expect(expirationConfirmationText).not.toContain(expirationMemoryId);
    expect(expirationConfirmationText).not.toContain(expirationSourceId);
    expect(expirationConfirmationText).not.toContain(expirationContent);
    expect(expirationConfirmationText).not.toContain(expirationProposal.proposalId);
    expect(reviewProposal).toHaveBeenCalledTimes(2);
    expect(reviewProposal).toHaveBeenLastCalledWith({
      authority: { kind: 'local_admin' },
      proposalId: expirationProposal.proposalId,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'expire',
      reasonCode: 'governance_http_expiration_confirmed',
    });
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(expirationProposal.proposalId)).toEqual({
      lifecycle_state: 'expired',
      current_revision_number: 2,
    });
    expect(app.getDatabase().prepare(
      `SELECT revision_number AS revisionNumber,
              transition,
              previous_state AS previousState,
              new_state AS newState,
              actor_class AS actorClass,
              invocation_context AS invocationContext,
              reason_code AS reasonCode
         FROM memory_maintenance_proposal_revisions
        WHERE proposal_id = ?
        ORDER BY revision_number`,
    ).all(expirationProposal.proposalId)).toEqual([
      expect.objectContaining({
        revisionNumber: 1,
        transition: 'propose',
        previousState: null,
        newState: 'pending_review',
      }),
      {
        revisionNumber: 2,
        transition: 'expire',
        previousState: 'pending_review',
        newState: 'expired',
        actorClass: 'admin',
        invocationContext: 'admin_cli',
        reasonCode: 'governance_http_expiration_confirmed',
      },
    ]);
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.expired' AND event_id = ?`,
    ).pluck().get(expirationProposal.proposalId)).toBe(expirationAuditCountBefore + 1);
    expect(app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(expirationMemoryId)).toEqual(expirationMemoryBefore);
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(expirationMemoryId)).toBe(expirationMemoryRevisionCountBefore);
    expect((await expirationMemories.retrieve({ state: 'active', limit: 20 }))
      .map((memory) => memory.id)).toContain(expirationMemoryId);

    const changesAfterExpirationConfirmation = app.getDatabase().prepare(
      'SELECT total_changes()',
    ).pluck().get();
    const replayedExpirationConfirmation = await fetch(
      `${origin}${expirationDetailPath}/confirm`,
      {
        method: 'POST',
        headers: previewHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: currentExpirationPreview.previewHandle,
          action: 'expire',
        }),
      },
    );
    expect(replayedExpirationConfirmation.status).toBe(409);
    expect(await replayedExpirationConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    expect(reviewProposal).toHaveBeenCalledTimes(2);
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get())
      .toBe(changesAfterExpirationConfirmation);
    expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

  });

  it('previews and confirms approved maintenance applications through the governed operation', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const secret = 'synthetic-private-application-preview';
    const platformId = '135792468';
    const nowMs = Date.parse('2032-01-04T00:00:00.000Z');
    const memoryIds = {
      conflictA: `synthetic-http-${platformId}-conflict-a`,
      conflictB: `synthetic-http-${platformId}-conflict-b`,
      consolidationRetained: `synthetic-http-${platformId}-consolidation-retained`,
      consolidationSuperseded: `synthetic-http-${platformId}-consolidation-superseded`,
      decay: `synthetic-http-${platformId}-decay`,
    };
    const memories = new MemoryRepository(app.getDatabase());
    for (const [ordinal, memoryId] of Object.values(memoryIds).entries()) {
      memories.createSync({
        id: memoryId,
        scope: 'system',
        visibility: 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: `Synthetic HTTP application preview ${ordinal}`,
        content: `${secret}-${ordinal}`,
        state: 'active',
        confidence: 0.7,
        importance: 0.5,
        sourceContext: 'admin_cli',
        sources: [{
          sourceType: 'user_command',
          sourceId: `synthetic-source-${platformId}-${ordinal}`,
          sourceTimestamp: nowMs - ordinal - 1,
          extractedBy: 'admin',
          external: true,
        }],
        actor: { actorClass: 'admin', context: 'admin_cli' },
      });
    }
    const audits = new AuditRepository(app.getDatabase());
    const proposals = {
      conflict: await createMemoryMaintenanceProposal(app.getDatabase(), audits, {
        kind: 'conflict',
        candidateMemoryIds: [memoryIds.conflictA, memoryIds.conflictB],
        reasonCodes: ['same_boundary_title_different_content'],
        proposedEffect: {
          type: 'resolve_conflict',
          candidateMemoryIds: [memoryIds.conflictA, memoryIds.conflictB],
        },
        nowMs,
      }),
      consolidation: await createMemoryMaintenanceProposal(app.getDatabase(), audits, {
        kind: 'consolidation',
        candidateMemoryIds: [
          memoryIds.consolidationRetained,
          memoryIds.consolidationSuperseded,
        ],
        reasonCodes: ['same_boundary_title_and_content'],
        proposedEffect: {
          type: 'consolidate',
          retainedMemoryId: memoryIds.consolidationRetained,
          supersedeMemoryIds: [memoryIds.consolidationSuperseded],
        },
        nowMs: nowMs + 1,
      }),
      decay: await createMemoryMaintenanceProposal(app.getDatabase(), audits, {
        kind: 'decay',
        candidateMemoryIds: [memoryIds.decay],
        reasonCodes: ['stale'],
        proposedEffect: { type: 'disable', memoryId: memoryIds.decay },
        nowMs: nowMs + 2,
      }),
    };

    await app.start();
    const origin = `http://127.0.0.1:${governancePort}`;
    const session = await loginGovernance(origin);
    const scopeResponse = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(scopeResponse.status).toBe(200);
    const scopeCatalog = await scopeResponse.json() as {
      entries: Array<{ scopeKind: string; handle: string }>;
    };
    const systemScope = scopeCatalog.entries.find((entry) => entry.scopeKind === 'system');
    const listResponse = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as {
      entries: Array<{
        kind: 'conflict' | 'consolidation' | 'decay';
        proposalRef: string;
        handle: string;
      }>;
    };
    expect(list.entries).toHaveLength(3);
    const resources = new Map(list.entries.map((entry) => [entry.kind, entry]));
    expect(resources.size).toBe(3);
    const details = new Map<string, {
      candidates: Array<{ memoryRef: string }>;
    }>();
    for (const [kind, resource] of resources) {
      const detailResponse = await fetch(
        `${origin}${API_PREFIX}/memory-reviews/${resource.handle}`,
        {
          headers: {
            Connection: 'close',
            Cookie: session.cookie,
            'X-LetheBot-Scope': systemScope?.handle ?? '',
          },
        },
      );
      expect(detailResponse.status).toBe(200);
      details.set(kind, await detailResponse.json() as {
        candidates: Array<{ memoryRef: string }>;
      });
    }
    const conflictRefs = details.get('conflict')?.candidates.map(
      (candidate) => candidate.memoryRef,
    ) ?? [];
    expect(conflictRefs).toHaveLength(2);
    expect(new Set(conflictRefs)).toHaveProperty('size', 2);
    const conflictMemoryIdByRef = new Map([
      memoryIds.conflictA,
      memoryIds.conflictB,
    ].map((memoryId) => [
      createHash('sha256')
        .update('lethebot-governance:memory:v1\0', 'utf8')
        .update(memoryId, 'utf8')
        .digest('hex')
        .slice(0, 16),
      memoryId,
    ]));
    const selectedConflictMemoryId = conflictMemoryIdByRef.get(conflictRefs[0]);
    expect(selectedConflictMemoryId).toBeDefined();

    const proposalRepository = new MemoryMaintenanceProposalRepository(
      app.getDatabase(),
      audits,
    );
    for (const [index, proposal] of Object.values(proposals).entries()) {
      const approved = proposalRepository.transitionReview({
        proposalId: proposal.proposalId,
        access: { kind: 'all' },
        expectedState: 'pending_review',
        expectedRevisionNumber: 1,
        transition: 'approve',
        actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
        authorityKind: 'local_admin',
        reasonCode: 'synthetic_http_application_preview_approval',
        nowMs: nowMs + 10 + index,
      });
      expect(approved.outcome).toBe('transitioned');
    }
    const issuePreviewHandle = vi.spyOn(GovernancePreviewHandleRegistry.prototype, 'issue');
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const reviewProposal = vi.spyOn(
      GovernanceService.prototype,
      'reviewMemoryMaintenanceProposal',
    );
    const applyProposal = vi.spyOn(
      GovernanceService.prototype,
      'applyMemoryMaintenanceProposal',
    );
    const rollbackProposal = vi.spyOn(
      GovernanceService.prototype,
      'rollbackMemoryMaintenanceProposal',
    );
    const changesBefore = app.getDatabase().prepare('SELECT total_changes()').pluck().get();
    const memoryStateBefore = app.getDatabase().prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'synthetic-http-135792468-%' ORDER BY id`,
    ).all();
    const memoryRevisionCountBefore = app.getDatabase().prepare(
      `SELECT COUNT(*) FROM memory_revisions
        WHERE memory_id LIKE 'synthetic-http-135792468-%'`,
    ).pluck().get();
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken,
      'X-LetheBot-Scope': systemScope?.handle ?? '',
      'Content-Type': 'application/json',
    };
    const issueApplicationPreview = async (
      kind: 'conflict' | 'consolidation' | 'decay',
      body: Record<string, unknown>,
    ) => {
      const resource = resources.get(kind);
      const response = await fetch(
        `${origin}${API_PREFIX}/memory-reviews/${resource?.handle ?? ''}`,
        {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(201);
      return response.json() as Promise<Record<string, unknown> & {
        previewHandle: string;
        previewExpiresAt: number;
        previewDigest: string;
        affectedRecords: {
          roles: Array<{ role: string; count: number; fingerprint: string }>;
        };
      }>;
    };

    const decayPreview = await issueApplicationPreview('decay', { action: 'apply' });
    const consolidationPreview = await issueApplicationPreview(
      'consolidation',
      { action: 'apply' },
    );
    const conflictPreview = await issueApplicationPreview('conflict', {
      action: 'apply',
      retainedMemoryRef: conflictRefs[0],
    });
    const alternateConflictPreview = await issueApplicationPreview('conflict', {
      action: 'apply',
      retainedMemoryRef: conflictRefs[1],
    });
    const expectedDurableEffects = [
      'proposal_state_transition',
      'proposal_revision_append',
      'audit_event_append',
      'memory_record_revision_append',
      'proposal_effect_evidence_append',
    ];
    expect(decayPreview).toMatchObject({
      action: 'memory.maintenance.apply',
      proposalKind: 'decay',
      proposalRef: resources.get('decay')?.proposalRef,
      proposedEffect: 'disable',
      affectedRecords: {
        count: 1,
        roles: [{
          role: 'disabled',
          count: 1,
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }],
      },
      selection: { required: false },
      current: { lifecycleState: 'approved', revisionNumber: 2 },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: 3,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['disabled_records_excluded'],
      },
      rollback: { supported: true, boundary: 'separate_confirmation_required' },
      previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      previewExpiresAt: expect.any(Number),
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(consolidationPreview).toMatchObject({
      action: 'memory.maintenance.apply',
      proposalKind: 'consolidation',
      proposalRef: resources.get('consolidation')?.proposalRef,
      proposedEffect: 'consolidate',
      affectedRecords: {
        count: 2,
        roles: [
          expect.objectContaining({ role: 'retained', count: 1 }),
          expect.objectContaining({ role: 'superseded', count: 1 }),
        ],
      },
      selection: { required: false },
      current: { lifecycleState: 'approved', revisionNumber: 2 },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: 3,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['superseded_records_excluded'],
      },
    });
    expect(conflictPreview).toMatchObject({
      action: 'memory.maintenance.apply',
      proposalKind: 'conflict',
      proposalRef: resources.get('conflict')?.proposalRef,
      proposedEffect: 'resolve_conflict',
      affectedRecords: {
        count: 2,
        roles: [
          expect.objectContaining({ role: 'retained', count: 1 }),
          expect.objectContaining({ role: 'superseded', count: 1 }),
        ],
      },
      selection: { required: true, retainedMemoryRef: conflictRefs[0] },
      current: { lifecycleState: 'approved', revisionNumber: 2 },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: 3,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['superseded_records_excluded'],
      },
    });
    expect(alternateConflictPreview).toMatchObject({
      selection: { required: true, retainedMemoryRef: conflictRefs[1] },
    });
    expect(alternateConflictPreview.previewDigest).not.toBe(conflictPreview.previewDigest);
    expect(alternateConflictPreview.affectedRecords.roles).not.toEqual(
      conflictPreview.affectedRecords.roles,
    );
    expect(new Set([
      decayPreview.previewHandle,
      consolidationPreview.previewHandle,
      conflictPreview.previewHandle,
      alternateConflictPreview.previewHandle,
    ])).toHaveProperty('size', 4);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(4);
    for (const [kind, callIndex] of [
      ['decay', 1],
      ['consolidation', 2],
      ['conflict', 3],
      ['conflict', 4],
    ] as const) {
      expect(issuePreviewHandle).toHaveBeenNthCalledWith(callIndex, {
        sessionId: digestSessionCookie(session.cookie),
        sessionExpiresAt: expect.any(Number),
        actor: { kind: 'local_admin' },
        action: 'memory.maintenance.apply',
        resourceKind: 'memory_maintenance_review',
        resourceId: proposals[kind].proposalId,
        scope: { kind: 'system' },
        expectedState: 'approved',
        expectedRevisionNumber: 2,
        previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }

    const conflictPath = `${origin}${API_PREFIX}/memory-reviews/${resources.get('conflict')?.handle ?? ''}`;
    const decayPath = `${origin}${API_PREFIX}/memory-reviews/${resources.get('decay')?.handle ?? ''}`;
    for (const [path, body, expectedStatus] of [
      [conflictPath, { action: 'apply' }, 404],
      [conflictPath, { action: 'apply', retainedMemoryRef: 'f'.repeat(16) }, 404],
      [decayPath, { action: 'apply', retainedMemoryRef: conflictRefs[0] }, 404],
      [conflictPath, { action: 'apply', retainedMemoryRef: 'short' }, 400],
      [conflictPath, { action: 'apply', retainedMemoryRef: conflictRefs[0], extra: true }, 400],
    ] as const) {
      const invalidPreview = await fetch(path, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidPreview.status).toBe(expectedStatus);
    }
    const queryPreview = await fetch(`${decayPath}?confirm=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ action: 'apply' }),
    });
    expect(queryPreview.status).toBe(400);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(4);
    expect(consumePreviewHandle).not.toHaveBeenCalled();
    expect(reviewProposal).not.toHaveBeenCalled();
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state AS lifecycleState,
              current_revision_number AS currentRevisionNumber,
              COUNT(*) AS count
         FROM memory_maintenance_proposals
        WHERE id IN (?, ?, ?)
        GROUP BY lifecycle_state, current_revision_number`,
    ).get(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual({ lifecycleState: 'approved', currentRevisionNumber: 2, count: 3 });
    expect(app.getDatabase().prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'synthetic-http-135792468-%' ORDER BY id`,
    ).all()).toEqual(memoryStateBefore);
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM memory_revisions
        WHERE memory_id LIKE 'synthetic-http-135792468-%'`,
    ).pluck().get()).toBe(memoryRevisionCountBefore);
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const confirmationPath = (kind: 'conflict' | 'consolidation' | 'decay') =>
      `${origin}${API_PREFIX}/memory-reviews/${resources.get(kind)?.handle ?? ''}/confirm`;
    const crossActionConfirmation = await fetch(confirmationPath('decay'), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: decayPreview.previewHandle,
        action: 'reject',
      }),
    });
    expect(crossActionConfirmation.status).toBe(404);
    for (const [kind, body] of [
      ['decay', {
        confirm: true,
        previewHandle: decayPreview.previewHandle,
        action: 'apply',
        extra: true,
      }],
      ['conflict', {
        confirm: true,
        previewHandle: conflictPreview.previewHandle,
        action: 'apply',
        retainedMemoryRef: 'short',
      }],
    ] as const) {
      const malformedConfirmation = await fetch(confirmationPath(kind), {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(malformedConfirmation.status).toBe(400);
    }
    const queriedConfirmation = await fetch(`${confirmationPath('decay')}?retry=true`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: decayPreview.previewHandle,
        action: 'apply',
      }),
    });
    expect(queriedConfirmation.status).toBe(400);

    type ApplicationConfirmation = Record<string, unknown> & {
      affectedRecords: unknown;
      selection: unknown;
      current: { lifecycleState: 'applied'; revisionNumber: number };
      retrievalConsequences: string[];
      evidence: { transition: string; revisionRef: string; auditRef: string };
    };
    const confirmApplication = async (
      kind: 'conflict' | 'consolidation' | 'decay',
      previewHandle: string,
      retainedMemoryRef?: string,
    ): Promise<ApplicationConfirmation> => {
      const response = await fetch(confirmationPath(kind), {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle,
          action: 'apply',
          ...(retainedMemoryRef === undefined ? {} : { retainedMemoryRef }),
        }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<ApplicationConfirmation>;
    };
    const mismatchedSelection = await fetch(confirmationPath('conflict'), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: alternateConflictPreview.previewHandle,
        action: 'apply',
        retainedMemoryRef: conflictRefs[0],
      }),
    });
    expect(mismatchedSelection.status).toBe(409);
    expect(applyProposal).not.toHaveBeenCalled();
    const decayConfirmation = await confirmApplication(
      'decay',
      decayPreview.previewHandle,
    );
    const consolidationConfirmation = await confirmApplication(
      'consolidation',
      consolidationPreview.previewHandle,
    );
    const conflictConfirmation = await confirmApplication(
      'conflict',
      conflictPreview.previewHandle,
      conflictRefs[0],
    );

    for (const [confirmation, preview, kind, proposedEffect, consequence] of [
      [
        decayConfirmation,
        decayPreview,
        'decay',
        'disable',
        'disabled_records_excluded',
      ],
      [
        consolidationConfirmation,
        consolidationPreview,
        'consolidation',
        'consolidate',
        'superseded_records_excluded',
      ],
      [
        conflictConfirmation,
        conflictPreview,
        'conflict',
        'resolve_conflict',
        'superseded_records_excluded',
      ],
    ] as const) {
      expect(confirmation).toMatchObject({
        action: 'memory.maintenance.apply',
        outcome: 'applied',
        proposalKind: kind,
        proposalRef: preview.proposalRef,
        proposedEffect,
        affectedRecords: preview.affectedRecords,
        selection: preview.selection,
        current: { lifecycleState: 'applied', revisionNumber: 3 },
        retrievalConsequences: [consequence],
        evidence: {
          transition: 'apply',
          revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
          auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        },
        rollback: { supported: true, boundary: 'separate_confirmation_required' },
      });
      expect(Object.keys(confirmation).sort()).toEqual([
        'action',
        'affectedRecords',
        'current',
        'evidence',
        'outcome',
        'proposalKind',
        'proposalRef',
        'proposedEffect',
        'retrievalConsequences',
        'rollback',
        'selection',
      ]);
    }
    expect(applyProposal).toHaveBeenCalledTimes(3);
    expect(applyProposal).toHaveBeenNthCalledWith(1, {
      authority: { kind: 'local_admin' },
      proposalId: proposals.decay.proposalId,
      expectedState: 'approved',
      expectedRevisionNumber: 2,
      reasonCode: 'governance_http_application_confirmed',
    });
    expect(applyProposal).toHaveBeenNthCalledWith(2, {
      authority: { kind: 'local_admin' },
      proposalId: proposals.consolidation.proposalId,
      expectedState: 'approved',
      expectedRevisionNumber: 2,
      reasonCode: 'governance_http_application_confirmed',
    });
    expect(applyProposal).toHaveBeenNthCalledWith(3, {
      authority: { kind: 'local_admin' },
      proposalId: proposals.conflict.proposalId,
      expectedState: 'approved',
      expectedRevisionNumber: 2,
      reasonCode: 'governance_http_application_confirmed',
      retainedMemoryId: selectedConflictMemoryId as string,
    });
    expect(reviewProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();

    const replayedConfirmation = await fetch(confirmationPath('decay'), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: decayPreview.previewHandle,
        action: 'apply',
      }),
    });
    expect(replayedConfirmation.status).toBe(409);
    expect(applyProposal).toHaveBeenCalledTimes(3);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(6);

    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state AS lifecycleState,
              current_revision_number AS currentRevisionNumber,
              COUNT(*) AS count
         FROM memory_maintenance_proposals
        WHERE id IN (?, ?, ?)
        GROUP BY lifecycle_state, current_revision_number`,
    ).get(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual({ lifecycleState: 'applied', currentRevisionNumber: 3, count: 3 });
    const memoryStateRows = app.getDatabase().prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'synthetic-http-135792468-%' ORDER BY id`,
    ).all() as Array<{ id: string; state: string }>;
    const memoryStates = new Map(memoryStateRows.map((row) => [row.id, row.state]));
    expect(memoryStates.get(selectedConflictMemoryId as string)).toBe('active');
    expect(memoryStates.get(
      selectedConflictMemoryId === memoryIds.conflictA
        ? memoryIds.conflictB
        : memoryIds.conflictA,
    )).toBe('superseded');
    expect(memoryStates.get(memoryIds.consolidationRetained)).toBe('active');
    expect(memoryStates.get(memoryIds.consolidationSuperseded)).toBe('superseded');
    expect(memoryStates.get(memoryIds.decay)).toBe('disabled');
    expect(app.getDatabase().prepare(
      `SELECT effect_role AS role, COUNT(*) AS count
         FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id IN (?, ?, ?)
        GROUP BY effect_role ORDER BY effect_role`,
    ).all(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual([
      { role: 'disabled', count: 1 },
      { role: 'retained', count: 2 },
      { role: 'superseded', count: 2 },
    ]);
    expect(app.getDatabase().prepare(
      `SELECT reason_code AS reasonCode
         FROM memory_maintenance_proposal_revisions
        WHERE proposal_id IN (?, ?, ?) AND transition = 'apply'
        ORDER BY proposal_id`,
    ).all(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual(Array.from(
      { length: 3 },
      () => ({ reasonCode: 'governance_http_application_confirmed' }),
    ));
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM memory_revisions
        WHERE memory_id LIKE 'synthetic-http-135792468-%'`,
    ).pluck().get()).toBe(Number(memoryRevisionCountBefore) + 5);
    const activeSyntheticMemoryIds = (await memories.retrieve({ state: 'active', limit: 20 }))
      .filter((memory) => memory.id.startsWith('synthetic-http-135792468-'))
      .map((memory) => memory.id)
      .sort();
    expect(activeSyntheticMemoryIds).toEqual([
      memoryIds.consolidationRetained,
      selectedConflictMemoryId as string,
    ].sort());
    expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    const changesAfterApplication = app.getDatabase().prepare(
      'SELECT total_changes()',
    ).pluck().get();
    const issueRollbackPreview = async (
      kind: 'conflict' | 'consolidation' | 'decay',
    ) => {
      const response = await fetch(
        `${origin}${API_PREFIX}/memory-reviews/${resources.get(kind)?.handle ?? ''}`,
        {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({ action: 'rollback' }),
        },
      );
      expect(response.status).toBe(201);
      return response.json() as Promise<Record<string, unknown> & {
        previewHandle: string;
        previewExpiresAt: number;
        previewDigest: string;
        affectedRecords: {
          roles: Array<{ role: string; count: number; fingerprint: string }>;
        };
      }>;
    };
    const rollbackPreviews = {
      decay: await issueRollbackPreview('decay'),
      consolidation: await issueRollbackPreview('consolidation'),
      conflict: await issueRollbackPreview('conflict'),
    };
    const candidateCounts = {
      decay: 1,
      consolidation: 2,
      conflict: 2,
    } as const;
    const proposedEffects = {
      decay: 'disable',
      consolidation: 'consolidate',
      conflict: 'resolve_conflict',
    } as const;
    for (const kind of ['decay', 'consolidation', 'conflict'] as const) {
      const preview = rollbackPreviews[kind];
      expect(preview).toMatchObject({
        action: 'memory.maintenance.rollback',
        proposalKind: kind,
        proposalRef: resources.get(kind)?.proposalRef,
        proposedEffect: proposedEffects[kind],
        affectedRecords: {
          count: candidateCounts[kind],
          fingerprint: proposals[kind].candidateFingerprint,
          roles: [{
            role: 'restored',
            count: candidateCounts[kind],
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          }],
        },
        current: { lifecycleState: 'applied', revisionNumber: 3 },
        expected: {
          lifecycleState: 'rolled_back',
          revisionNumber: 4,
          durableEffects: expectedDurableEffects,
          retrievalConsequences: ['restored_records_included'],
        },
        confirmation: {
          required: true,
          boundary: 'separate_confirmation_required',
        },
        previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        previewExpiresAt: expect.any(Number),
        previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }
    expect(new Set(Object.values(rollbackPreviews).map(
      (preview) => preview.previewHandle,
    ))).toHaveProperty('size', 3);
    expect(issuePreviewHandle).toHaveBeenCalledTimes(7);
    for (const [kind, callIndex] of [
      ['decay', 5],
      ['consolidation', 6],
      ['conflict', 7],
    ] as const) {
      expect(issuePreviewHandle).toHaveBeenNthCalledWith(callIndex, {
        sessionId: digestSessionCookie(session.cookie),
        sessionExpiresAt: expect.any(Number),
        actor: { kind: 'local_admin' },
        action: 'memory.maintenance.rollback',
        resourceKind: 'memory_maintenance_review',
        resourceId: proposals[kind].proposalId,
        scope: { kind: 'system' },
        expectedState: 'applied',
        expectedRevisionNumber: 3,
        previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }
    const invalidRollbackPreview = await fetch(
      `${origin}${API_PREFIX}/memory-reviews/${resources.get('conflict')?.handle ?? ''}`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          action: 'rollback',
          retainedMemoryRef: conflictRefs[0],
        }),
      },
    );
    expect(invalidRollbackPreview.status).toBe(400);
    const queriedRollbackPreview = await fetch(
      `${origin}${API_PREFIX}/memory-reviews/${resources.get('decay')?.handle ?? ''}?confirm=true`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ action: 'rollback' }),
      },
    );
    expect(queriedRollbackPreview.status).toBe(400);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(6);
    expect(reviewProposal).not.toHaveBeenCalled();
    expect(applyProposal).toHaveBeenCalledTimes(3);
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'synthetic-http-135792468-%' ORDER BY id`,
    ).all()).toEqual(memoryStateRows);
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get())
      .toBe(changesAfterApplication);
    expect((await memories.retrieve({ state: 'active', limit: 20 }))
      .filter((memory) => memory.id.startsWith('synthetic-http-135792468-'))
      .map((memory) => memory.id)
      .sort()).toEqual(activeSyntheticMemoryIds);
    const invalidRollbackConfirmation = await fetch(confirmationPath('conflict'), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: rollbackPreviews.conflict.previewHandle,
        action: 'rollback',
        retainedMemoryRef: conflictRefs[0],
      }),
    });
    expect(invalidRollbackConfirmation.status).toBe(400);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(6);

    const crossActionRollbackConfirmation = await fetch(confirmationPath('conflict'), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: rollbackPreviews.conflict.previewHandle,
        action: 'apply',
      }),
    });
    expect(crossActionRollbackConfirmation.status).toBe(404);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(7);
    expect(rollbackProposal).not.toHaveBeenCalled();

    const confirmRollback = async (
      kind: 'conflict' | 'consolidation' | 'decay',
    ): Promise<Record<string, unknown>> => {
      const response = await fetch(confirmationPath(kind), {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle: rollbackPreviews[kind].previewHandle,
          action: 'rollback',
        }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const rollbackConfirmations = {
      decay: await confirmRollback('decay'),
      consolidation: await confirmRollback('consolidation'),
      conflict: await confirmRollback('conflict'),
    };
    for (const kind of ['decay', 'consolidation', 'conflict'] as const) {
      const confirmation = rollbackConfirmations[kind];
      expect(confirmation).toMatchObject({
        action: 'memory.maintenance.rollback',
        outcome: 'rolled_back',
        proposalKind: kind,
        proposalRef: resources.get(kind)?.proposalRef,
        proposedEffect: proposedEffects[kind],
        affectedRecords: rollbackPreviews[kind].affectedRecords,
        current: { lifecycleState: 'rolled_back', revisionNumber: 4 },
        retrievalConsequences: ['restored_records_included'],
        evidence: {
          transition: 'rollback',
          revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
          auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        },
        rollback: {
          supported: false,
          boundary: 'rollback_is_terminal',
        },
      });
      expect(Object.keys(confirmation).sort()).toEqual([
        'action',
        'affectedRecords',
        'current',
        'evidence',
        'outcome',
        'proposalKind',
        'proposalRef',
        'proposedEffect',
        'retrievalConsequences',
        'rollback',
      ]);
    }
    expect(rollbackProposal).toHaveBeenCalledTimes(3);
    for (const [kind, callIndex] of [
      ['decay', 1],
      ['consolidation', 2],
      ['conflict', 3],
    ] as const) {
      expect(rollbackProposal).toHaveBeenNthCalledWith(callIndex, {
        authority: { kind: 'local_admin' },
        proposalId: proposals[kind].proposalId,
        expectedState: 'applied',
        expectedRevisionNumber: 3,
        reasonCode: 'governance_http_rollback_confirmed',
      });
    }
    const replayedRollback = await fetch(confirmationPath('decay'), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: rollbackPreviews.decay.previewHandle,
        action: 'rollback',
      }),
    });
    expect(replayedRollback.status).toBe(409);
    expect(rollbackProposal).toHaveBeenCalledTimes(3);
    expect(consumePreviewHandle).toHaveBeenCalledTimes(11);
    expect(applyProposal).toHaveBeenCalledTimes(3);
    expect(reviewProposal).not.toHaveBeenCalled();

    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state AS lifecycleState,
              current_revision_number AS currentRevisionNumber,
              COUNT(*) AS count
         FROM memory_maintenance_proposals
        WHERE id IN (?, ?, ?)
        GROUP BY lifecycle_state, current_revision_number`,
    ).get(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual({ lifecycleState: 'rolled_back', currentRevisionNumber: 4, count: 3 });
    expect(app.getDatabase().prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'synthetic-http-135792468-%' ORDER BY id`,
    ).all()).toEqual(Object.values(memoryIds).sort().map((id) => ({ id, state: 'active' })));
    expect(app.getDatabase().prepare(
      `SELECT effect_role AS role, COUNT(*) AS count
         FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id IN (?, ?, ?)
        GROUP BY effect_role ORDER BY effect_role`,
    ).all(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual([
      { role: 'disabled', count: 1 },
      { role: 'restored', count: 5 },
      { role: 'retained', count: 2 },
      { role: 'superseded', count: 2 },
    ]);
    expect(app.getDatabase().prepare(
      `SELECT reason_code AS reasonCode
         FROM memory_maintenance_proposal_revisions
        WHERE proposal_id IN (?, ?, ?) AND transition = 'rollback'
        ORDER BY proposal_id`,
    ).all(
      proposals.conflict.proposalId,
      proposals.consolidation.proposalId,
      proposals.decay.proposalId,
    )).toEqual(Array.from(
      { length: 3 },
      () => ({ reasonCode: 'governance_http_rollback_confirmed' }),
    ));
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM memory_revisions
        WHERE memory_id LIKE 'synthetic-http-135792468-%'`,
    ).pluck().get()).toBe(Number(memoryRevisionCountBefore) + 10);
    expect((await memories.retrieve({ state: 'active', limit: 20 }))
      .filter((memory) => memory.id.startsWith('synthetic-http-135792468-'))
      .map((memory) => memory.id)
      .sort()).toEqual(Object.values(memoryIds).sort());
    expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    const serialized = JSON.stringify({
      decayPreview,
      consolidationPreview,
      conflictPreview,
      alternateConflictPreview,
      decayConfirmation,
      consolidationConfirmation,
      conflictConfirmation,
      rollbackPreviews,
      rollbackConfirmations,
    });
    for (const rawValue of [
      secret,
      platformId,
      ...Object.values(memoryIds),
      ...Object.values(proposals).map((proposal) => proposal.proposalId),
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
  });

  it('confirms one rejection without applying the proposal or mutating memory', async () => {
    const applicationPort = await reserveLoopbackPort();
    const governancePort = await reserveLoopbackPort();
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      LETHEBOT_GOVERNANCE_SESSION_TTL_MS: '60000',
    });
    apps.push(app);
    const memoryId = 'synthetic-http-rejection-memory-123456789';
    const sourceId = 'synthetic-http-rejection-source-987654321';
    const privateContent = 'synthetic-private-rejection-content';
    const nowMs = Date.parse('2032-01-03T00:00:00.000Z');
    new MemoryRepository(app.getDatabase()).createSync({
      id: memoryId,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic HTTP rejection fixture',
      content: privateContent,
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId,
        sourceTimestamp: nowMs - 1,
        extractedBy: 'admin',
        external: true,
      }],
      actor: { actorClass: 'admin', context: 'admin_cli' },
    });
    const proposal = await createMemoryMaintenanceProposal(
      app.getDatabase(),
      new AuditRepository(app.getDatabase()),
      {
        kind: 'decay',
        candidateMemoryIds: [memoryId],
        reasonCodes: ['stale'],
        proposedEffect: { type: 'disable', memoryId },
        nowMs,
      },
    );
    const consumePreviewHandle = vi.spyOn(
      GovernancePreviewHandleRegistry.prototype,
      'consumeWithOutcome',
    );
    const reviewProposal = vi.spyOn(
      GovernanceService.prototype,
      'reviewMemoryMaintenanceProposal',
    );
    const applyProposal = vi.spyOn(
      GovernanceService.prototype,
      'applyMemoryMaintenanceProposal',
    );
    const rollbackProposal = vi.spyOn(
      GovernanceService.prototype,
      'rollbackMemoryMaintenanceProposal',
    );

    await app.start();
    const origin = `http://127.0.0.1:${governancePort}`;
    const session = await loginGovernance(origin);
    const scopeResponse = await fetch(`${origin}${API_PREFIX}/scopes`, {
      headers: { Connection: 'close', Cookie: session.cookie },
    });
    expect(scopeResponse.status).toBe(200);
    const scopeCatalog = await scopeResponse.json() as {
      entries: Array<{ scopeKind: string; handle: string }>;
    };
    const systemScope = scopeCatalog.entries.find((entry) => entry.scopeKind === 'system');
    const listResponse = await fetch(`${origin}${API_PREFIX}/memory-reviews`, {
      headers: {
        Connection: 'close',
        Cookie: session.cookie,
        'X-LetheBot-Scope': systemScope?.handle ?? '',
      },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as {
      entries: Array<{ handle: string }>;
    };
    expect(list.entries).toHaveLength(1);
    const detailPath = `${API_PREFIX}/memory-reviews/${list.entries[0]?.handle ?? ''}`;
    const mutationHeaders = {
      Connection: 'close',
      Cookie: session.cookie,
      Origin: origin,
      'X-LetheBot-CSRF': session.csrfToken,
      'X-LetheBot-Scope': systemScope?.handle ?? '',
      'Content-Type': 'application/json',
    };
    const issuePreview = async (action: 'approve' | 'reject') => {
      const response = await fetch(`${origin}${detailPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ action }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{
        action: string;
        previewHandle: string;
        previewDigest: string;
        proposalRef: string;
      }>;
    };
    const rejectionPreview = await issuePreview('reject');
    const repeatedRejectionPreview = await issuePreview('reject');
    const approvalPreview = await issuePreview('approve');
    expect(rejectionPreview.action).toBe('memory.maintenance.review.reject');
    expect(repeatedRejectionPreview.previewDigest).toBe(rejectionPreview.previewDigest);
    expect(repeatedRejectionPreview.previewHandle).not.toBe(rejectionPreview.previewHandle);
    expect(approvalPreview.previewDigest).not.toBe(rejectionPreview.previewDigest);

    const memoryRecordBefore = app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(memoryId);
    const memoryRevisionCountBefore = app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(memoryId);
    const rejectionAuditCountBefore = app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.rejected' AND event_id = ?`,
    ).pluck().get(proposal.proposalId) as number;
    const changesBeforeConfirmation = app.getDatabase().prepare(
      'SELECT total_changes()',
    ).pluck().get();
    const confirmPath = `${detailPath}/confirm`;

    for (const body of [
      {
        confirm: true,
        previewHandle: rejectionPreview.previewHandle,
        action: 'approve',
      },
      {
        confirm: true,
        previewHandle: rejectionPreview.previewHandle,
        action: 'reject',
        extra: true,
      },
    ]) {
      const invalidConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      expect(invalidConfirmation.status).toBe(400);
      expect(await invalidConfirmation.text()).toBe(JSON.stringify({ error: 'bad_request' }));
    }
    expect(consumePreviewHandle).not.toHaveBeenCalled();

    const wrongActionForRejectionHandle = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: rejectionPreview.previewHandle,
      }),
    });
    expect(wrongActionForRejectionHandle.status).toBe(404);
    expect(await wrongActionForRejectionHandle.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(consumePreviewHandle).toHaveLastReturnedWith({ outcome: 'not_found_or_denied' });

    const wrongActionForApprovalHandle = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: approvalPreview.previewHandle,
        action: 'reject',
      }),
    });
    expect(wrongActionForApprovalHandle.status).toBe(404);
    expect(await wrongActionForApprovalHandle.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(consumePreviewHandle).toHaveLastReturnedWith({ outcome: 'not_found_or_denied' });

    const unknownPreview = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: 'z'.repeat(43),
        action: 'reject',
      }),
    });
    expect(unknownPreview.status).toBe(404);
    expect(await unknownPreview.text()).toBe(JSON.stringify({ error: 'not_found' }));
    expect(reviewProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare('SELECT total_changes()').pluck().get())
      .toBe(changesBeforeConfirmation);

    const confirmation = await fetch(`${origin}${confirmPath}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        confirm: true,
        previewHandle: rejectionPreview.previewHandle,
        action: 'reject',
      }),
    });
    expect(confirmation.status).toBe(200);
    const confirmationText = await confirmation.text();
    const confirmationBody = JSON.parse(confirmationText) as Record<string, unknown>;
    expect(confirmationBody).toMatchObject({
      action: 'memory.maintenance.review.reject',
      outcome: 'rejected',
      proposalRef: rejectionPreview.proposalRef,
      current: {
        lifecycleState: 'rejected',
        revisionNumber: 2,
      },
      evidence: {
        transition: 'reject',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'rejection_does_not_apply_memory_effects',
      },
    });
    expect(Object.keys(confirmationBody).sort()).toEqual([
      'action',
      'current',
      'evidence',
      'memoryRecordMutation',
      'outcome',
      'proposalRef',
      'rollback',
    ]);
    expect(confirmationText).not.toContain(memoryId);
    expect(confirmationText).not.toContain(sourceId);
    expect(confirmationText).not.toContain(privateContent);
    expect(confirmationText).not.toContain(proposal.proposalId);
    expect(reviewProposal).toHaveBeenCalledTimes(1);
    expect(reviewProposal).toHaveBeenCalledWith({
      authority: { kind: 'local_admin' },
      proposalId: proposal.proposalId,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      reasonCode: 'governance_http_rejection_confirmed',
    });
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposal.proposalId)).toEqual({
      lifecycle_state: 'rejected',
      current_revision_number: 2,
    });
    expect(app.getDatabase().prepare(
      `SELECT revision_number AS revisionNumber,
              transition,
              previous_state AS previousState,
              new_state AS newState,
              actor_class AS actorClass,
              invocation_context AS invocationContext,
              reason_code AS reasonCode
         FROM memory_maintenance_proposal_revisions
        WHERE proposal_id = ?
        ORDER BY revision_number`,
    ).all(proposal.proposalId)).toEqual([
      expect.objectContaining({
        revisionNumber: 1,
        transition: 'propose',
        previousState: null,
        newState: 'pending_review',
      }),
      {
        revisionNumber: 2,
        transition: 'reject',
        previousState: 'pending_review',
        newState: 'rejected',
        actorClass: 'admin',
        invocationContext: 'admin_cli',
        reasonCode: 'governance_http_rejection_confirmed',
      },
    ]);
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.rejected' AND event_id = ?`,
    ).pluck().get(proposal.proposalId)).toBe(rejectionAuditCountBefore + 1);
    expect(app.getDatabase().prepare(
      `SELECT state, updated_at AS updatedAt, evaluator_decision_id AS evaluatorDecisionId
         FROM memory_records WHERE id = ?`,
    ).get(memoryId)).toEqual(memoryRecordBefore);
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?',
    ).pluck().get(memoryId)).toBe(memoryRevisionCountBefore);

    for (const previewHandle of [
      rejectionPreview.previewHandle,
      repeatedRejectionPreview.previewHandle,
    ]) {
      const staleOrConsumedConfirmation = await fetch(`${origin}${confirmPath}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          confirm: true,
          previewHandle,
          action: 'reject',
        }),
      });
      expect(staleOrConsumedConfirmation.status).toBe(409);
      expect(await staleOrConsumedConfirmation.text()).toBe(JSON.stringify({ error: 'conflict' }));
    }
    expect(reviewProposal).toHaveBeenCalledTimes(1);
    expect(applyProposal).not.toHaveBeenCalled();
    expect(rollbackProposal).not.toHaveBeenCalled();
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) FROM memory_maintenance_proposal_revisions WHERE proposal_id = ?',
    ).pluck().get(proposal.proposalId)).toBe(2);
    expect(app.getDatabase().prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.maintenance.rejected' AND event_id = ?`,
    ).pluck().get(proposal.proposalId)).toBe(rejectionAuditCountBefore + 1);
    expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('closes the application listener when the governance listener cannot start', async () => {
    const applicationPort = await reserveLoopbackPort();
    const occupied = createServer();
    const governancePort = await listenOnLoopback(occupied);
    occupiedServers.push(occupied);
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    apps.push(app);

    await expect(app.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(fetchClosed(applicationPort, '/healthz')).rejects.toThrow();
  });

  it('closes the governance listener when the application listener cannot start', async () => {
    const occupied = createServer();
    const applicationPort = await listenOnLoopback(occupied);
    occupiedServers.push(occupied);
    const governancePort = await reserveLoopbackPort();
    const app = createTestApp(applicationPort, governancePort, {
      LETHEBOT_GOVERNANCE_ENABLED: 'true',
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    apps.push(app);

    await expect(app.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(fetchClosed(governancePort, `${API_PREFIX}/session`)).rejects.toThrow();
  });

  function createTestApp(
    applicationPort: number,
    governancePort: number,
    overrides: Record<string, string> = {},
  ): LetheBotApp {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-wiring-'));
    testDirs.push(testDir);
    const env = {
      ...originalEnv,
      LETHEBOT_TEST: 'true',
      LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
      LETHEBOT_HOST: '127.0.0.1',
      LETHEBOT_PORT: String(applicationPort),
      ONEBOT_TRANSPORT: 'http',
      ONEBOT_TOKEN: 'synthetic-onebot-token',
      LETHEBOT_BOT_QQ_ID: '61000',
      LETHEBOT_REVERSE_HTTP_ENABLED: 'false',
      PI_PROVIDER: 'mock',
      PI_MODEL: 'mock',
      LOG_LEVEL: 'fatal',
      LETHEBOT_GOVERNANCE_PORT: String(governancePort),
      ...overrides,
    };
    delete env.LETHEBOT_GOVERNANCE_ENABLED;
    delete env.LETHEBOT_GOVERNANCE_HOST;
    delete env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN;
    delete env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS;
    Object.assign(env, overrides);
    process.env = env;
    resetConfig();
    return new LetheBotApp();
  }
});

async function fetchClosed(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Connection: 'close' },
  });
}

async function loginGovernance(origin: string): Promise<{
  cookie: string;
  csrfToken: string;
}> {
  const response = await fetch(`${origin}${API_PREFIX}/session`, {
    method: 'POST',
    headers: {
      Connection: 'close',
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { csrfToken: string };
  expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return {
    cookie: extractCookie(response.headers),
    csrfToken: body.csrfToken,
  };
}

function digestSessionCookie(cookie: string): string {
  const value = cookie.slice(`${SESSION_COOKIE}=`.length);
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function extractCookie(headers: Headers): string {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Expected governance session cookie');
  }
  const cookie = setCookie.split(';', 1)[0] ?? '';
  expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
  return cookie;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listenOnLoopback(server);
  await closeServer(server);
  return port;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected a TCP listener address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
