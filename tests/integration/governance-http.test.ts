import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request, type ClientRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GovernanceHttpServer,
  type GovernanceHttpRoute,
  type GovernanceHttpServerOptions,
} from '../../src/http/governance-http-server.js';

const ADMIN_TOKEN = 'synthetic-governance-admin-token-0001';
const SESSION_COOKIE = 'lethebot_governance_session';
const API_PREFIX = '/governance/api/v1';
const READ_PATH = `${API_PREFIX}/synthetic/read`;
const WRITE_PATH = `${API_PREFIX}/synthetic/write`;
const REPLACE_PATH = `${API_PREFIX}/synthetic/replace`;
const UPDATE_PATH = `${API_PREFIX}/synthetic/update`;
const REMOVE_PATH = `${API_PREFIX}/synthetic/remove`;
const UNSCOPED_PATH = `${API_PREFIX}/synthetic/session-context`;
const RESOURCE_READ_BASE_PATH = `${API_PREFIX}/synthetic/resources`;
const RESOURCE_READ_ROUTE_PATH = `${RESOURCE_READ_BASE_PATH}/:resourceHandle`;
const RESOURCE_PREVIEW_ROUTE_PATH = RESOURCE_READ_ROUTE_PATH;
const RESOURCE_CONFIRM_ROUTE_PATH = `${RESOURCE_READ_ROUTE_PATH}/confirm`;
const RESOURCE_OTHER_PURPOSE_BASE_PATH = `${API_PREFIX}/synthetic/other-purpose-resources`;
const RESOURCE_OTHER_PURPOSE_ROUTE_PATH = `${RESOURCE_OTHER_PURPOSE_BASE_PATH}/:resourceHandle`;
const RESOURCE_OTHER_KIND_BASE_PATH = `${API_PREFIX}/synthetic/other-kind-resources`;
const RESOURCE_OTHER_KIND_ROUTE_PATH = `${RESOURCE_OTHER_KIND_BASE_PATH}/:resourceHandle`;
const READ_HANDLE = 'r'.repeat(43);
const SECOND_READ_HANDLE = 's'.repeat(43);
const OTHER_SCOPE_HANDLE = 'o'.repeat(43);
const OTHER_PURPOSE_SCOPE_HANDLE = 'p'.repeat(43);
const WRITE_HANDLE = 'w'.repeat(43);
const UNKNOWN_HANDLE = 'u'.repeat(43);
const MISMATCHED_HANDLE = 'm'.repeat(43);
const RESOURCE_HANDLE = 'd'.repeat(43);
const UNKNOWN_RESOURCE_HANDLE = 'n'.repeat(43);
const RESOURCE_KIND = 'synthetic_record';
const CHROMIUM_PATH = '/usr/bin/chromium';

type CdpValue = Record<string, unknown>;

interface CdpClient {
  readonly send: (method: string, params?: CdpValue, sessionId?: string) => Promise<CdpValue>;
  readonly close: () => void;
}

async function connectCdp(browser: ChildProcessWithoutNullStreams): Promise<CdpClient> {
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (match?.[1]) {
        browser.stderr.off('data', onData);
        resolve(match[1]);
      }
    };
    browser.stderr.on('data', onData);
    browser.once('exit', () => reject(new Error('Chromium exited before CDP endpoint')));
  });
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')));
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: CdpValue) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpValue;
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve((message.result as CdpValue | undefined) ?? {});
  });
  const send = (method: string, params: CdpValue = {}, sessionId?: string): Promise<CdpValue> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
  return { send, close: () => socket.close() };
}

async function evaluateInChromium(
  client: CdpClient,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const exceptionDetails = result.exceptionDetails as CdpValue | undefined;
  if (exceptionDetails) {
    const exception = exceptionDetails.exception as CdpValue | undefined;
    throw new Error(String(exception?.description ?? exceptionDetails.text ?? 'Chromium evaluation failed'));
  }
  const remote = result.result as CdpValue | undefined;
  if (!remote || remote.type === 'undefined') return undefined;
  if (remote.type === 'object' && remote.value === undefined && remote.description) {
    throw new Error(String(remote.description));
  }
  return remote.value;
}

const AUTHORIZED_ROUTES = [
  { method: 'GET', path: READ_PATH, purpose: 'memory.read', mutation: false },
  { method: 'POST', path: WRITE_PATH, purpose: 'memory.write', mutation: true },
  { method: 'PUT', path: REPLACE_PATH, purpose: 'memory.write', mutation: true },
  { method: 'PATCH', path: UPDATE_PATH, purpose: 'memory.write', mutation: true },
  { method: 'DELETE', path: REMOVE_PATH, purpose: 'memory.write', mutation: true },
  {
    method: 'GET',
    path: RESOURCE_READ_ROUTE_PATH,
    purpose: 'memory.read',
    mutation: false,
    resourceKind: RESOURCE_KIND,
  },
  {
    method: 'POST',
    path: RESOURCE_PREVIEW_ROUTE_PATH,
    purpose: 'memory.read',
    mutation: true,
    resourceKind: RESOURCE_KIND,
  },
  {
    method: 'GET',
    path: RESOURCE_OTHER_PURPOSE_ROUTE_PATH,
    purpose: 'memory.other',
    mutation: false,
    resourceKind: RESOURCE_KIND,
  },
  {
    method: 'GET',
    path: RESOURCE_OTHER_KIND_ROUTE_PATH,
    purpose: 'memory.read',
    mutation: false,
    resourceKind: 'synthetic_other_record',
  },
] as const;

interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

interface LoginResult extends HttpResult {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface Harness {
  readonly server: GovernanceHttpServer;
  readonly port: number;
  readonly origin: string;
  readonly now: { value: number };
  readonly resolveScopeHandle: ReturnType<typeof vi.fn>;
  readonly resolveResourceHandle: ReturnType<typeof vi.fn>;
  readonly handleAuthorizedRequest: ReturnType<typeof vi.fn>;
}

function assertFixedActivityListShell(
  html: string,
  script: string,
  definition: { readonly view: string; readonly prefix: string; readonly label: string },
): void {
  expect(html).toContain('id="model-invocations-tab"');
  expect(html).toContain('id="model-invocations-panel"');
  expect(html).not.toContain(`id="${definition.prefix}-tab"`);
  expect(script.replaceAll('\n', '')).toContain(
    `'${definition.view}','${definition.prefix}','${definition.label}',`,
  );
  for (const suffix of [
    'tab',
    'panel',
    'refresh-button',
    'count',
    'loading',
    'content',
    'table',
    'list',
  ]) {
    expect(script).toContain(`prefix + '-${suffix}'`);
  }
  expect(script).toContain("id: prefix + '-' + suffix");
  expect(script).toContain("'aria-controls': prefix + '-panel'");
  expect(script).toContain("'aria-labelledby': prefix + '-tab'");
  expect(script).toContain('document.createElement(tag)');
  expect(script).toContain('element.textContent = text');
}

describe('governance HTTP security boundary', () => {
  const startedServers: GovernanceHttpServer[] = [];
  const partialRequests: ClientRequest[] = [];

  afterEach(async () => {
    for (const partialRequest of partialRequests.splice(0)) {
      partialRequest.destroy();
    }
    for (const server of startedServers.splice(0).reverse()) {
      await server.close();
    }
    vi.restoreAllMocks();
  });

  it('keeps the listener disabled by default and accepts only exact loopback hosts', async () => {
    const port = await reserveLoopbackPort();
    const disabled = new GovernanceHttpServer(createOptions({
      enabled: false,
      host: '127.0.0.1',
      port,
      adminToken: undefined,
    }));

    await disabled.start();
    await expect(fetch(`http://127.0.0.1:${port}${API_PREFIX}/session`)).rejects.toThrow();
    await disabled.close();

    expect(() => new GovernanceHttpServer(createOptions({
      enabled: false,
      host: '::1',
      port,
      adminToken: undefined,
    }))).not.toThrow();

    for (const host of ['localhost', '0.0.0.0', '127.0.0.2', '::ffff:127.0.0.1']) {
      expect(() => new GovernanceHttpServer(createOptions({
        enabled: true,
        host,
        port,
      }))).toThrow('Invalid governance HTTP configuration');
    }

    expect(() => new GovernanceHttpServer(createOptions({
      enabled: true,
      host: '127.0.0.1',
      port,
      adminToken: undefined,
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      enabled: true,
      host: '127.0.0.1',
      port,
      sessionTtlMs: 59_999,
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      enabled: true,
      host: '127.0.0.1',
      port,
      sessionTtlMs: 3_600_001,
    }))).toThrow('Invalid governance HTTP configuration');

    const unscopedRoute = {
      method: 'GET',
      path: UNSCOPED_PATH,
      purpose: 'memory.maintenance.review.scopes',
      mutation: false,
    } as const;
    expect(() => new GovernanceHttpServer(createOptions({
      authorizedRoutes: [unscopedRoute],
      authenticatedUnscopedRoutes: [unscopedRoute],
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      authenticatedUnscopedRoutes: [{
        ...unscopedRoute,
        path: `${API_PREFIX}/session`,
      }],
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      authenticatedUnscopedRoutes: [{
        ...unscopedRoute,
        method: 'POST',
      }],
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      authorizedRoutes: [{
        method: 'GET',
        path: `${API_PREFIX}/synthetic/missing-kind/:resourceHandle`,
        purpose: 'memory.read',
        mutation: false,
      }],
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      authorizedRoutes: [{
        method: 'GET',
        path: `${API_PREFIX}/synthetic/static-resource`,
        purpose: 'memory.read',
        mutation: false,
        resourceKind: RESOURCE_KIND,
      }],
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      authorizedRoutes: [{
        method: 'POST',
        path: `${RESOURCE_CONFIRM_ROUTE_PATH}/extra`,
        purpose: 'memory.read',
        mutation: true,
        resourceKind: RESOURCE_KIND,
      }],
    }))).toThrow('Invalid governance HTTP configuration');
    expect(() => new GovernanceHttpServer(createOptions({
      authenticatedUnscopedRoutes: [{
        ...unscopedRoute,
        path: `${API_PREFIX}/synthetic/unscoped/:resourceHandle`,
        resourceKind: RESOURCE_KIND,
      }],
    }))).toThrow('Invalid governance HTTP configuration');

    const invalidPreviewStoreOptions = {
      ...createOptions(),
      previewHandles: { revokeSession: () => undefined },
    };
    expect(() => new GovernanceHttpServer(
      invalidPreviewStoreOptions as unknown as GovernanceHttpServerOptions,
    ))
      .toThrow('Invalid governance HTTP configuration');
  });

  it('serves a dependency-free browser shell without creating API authority or effects', async () => {
    const harness = await startHarness();

    const root = await send(harness, '/governance/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const rootWithoutSlash = await send(harness, '/governance');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    expect(rootWithoutSlash.body).toBe(root.body);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    for (const asset of [root, rootWithoutSlash, css, script]) {
      expect(asset.status).toBe(200);
      assertSecurityHeaders(asset.headers);
      expect(asset.headers.get('set-cookie')).toBeNull();
      expect(Number(asset.headers.get('content-length'))).toBe(
        Buffer.byteLength(asset.body, 'utf8'),
      );
      expect(asset.body).not.toContain(ADMIN_TOKEN);
      expect(asset.body).not.toContain(READ_HANDLE);
      expect(asset.body).not.toContain(RESOURCE_HANDLE);
    }
    expect(root.body).toContain('<!doctype html>');
    expect(root.body).toContain('<main id="main-content"');
    expect(root.body).toContain('id="login-form"');
    expect(root.body).toContain('id="overview-view"');
    expect(root.body).toContain('href="/governance/app.css"');
    expect(root.body).toContain('src="/governance/app.js"');
    expect(root.body).toContain('aria-live="polite"');
    expect(root.body).not.toContain('<style');
    expect(root.body).not.toMatch(/<script(?![^>]+src=)/u);

    expect(css.body).toContain(':focus-visible');
    expect(css.body).toContain('min-height: 44px');
    expect(css.body).toContain('letter-spacing: 0');
    expect(css.body).toContain('.primary-navigation[hidden] + main');
    expect(css.body).toContain('@media (max-width: 760px)');
    expect(css.body).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css.body).not.toContain('gradient');

    expect(script.body).toContain('/governance/api/v1/session');
    expect(script.body).toContain('/governance/api/v1/overview');
    expect(script.body).toContain("credentials: 'same-origin'");
    expect(script.body).toContain('textContent');
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(script.body).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);

    const query = await send(harness, '/governance/?token=synthetic-browser-secret');
    const unknown = await send(harness, '/governance/missing.css');
    const wrongMethod = await send(harness, '/governance/', { method: 'POST' });
    const protectedApi = await send(harness, READ_PATH);
    expect([query.status, unknown.status, wrongMethod.status, protectedApi.status]).toEqual([
      404,
      404,
      404,
      401,
    ]);
    expect(query.body).not.toContain('synthetic-browser-secret');
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only model-invocation Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    expect(root.body).toContain('id="activity-nav"');
    expect(root.body).toContain('aria-controls="activity-view"');
    for (const id of [
      'overview-nav',
      'activity-view',
      'activity-refresh-button',
      'activity-generated-at',
      'activity-loading',
      'activity-error',
      'activity-empty',
      'activity-content',
      'activity-total',
      'purpose-summary',
      'purpose-evaluator',
      'purpose-pi-turn',
      'status-running',
      'status-completed',
      'status-failed',
      'status-aborted',
      'usage-known',
      'usage-unknown',
      'latency-count',
      'latency-sum',
      'latency-max',
    ]) {
      expect(root.body).toContain(`id="${id}"`);
    }
    expect(root.body).toContain('aria-labelledby="activity-title"');
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-view');
    expect(css.body).toContain('.activity-summary');
    expect(css.body).toContain('.primary-navigation');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const BASE = '/governance/api/v1/activity/';",
    );
    expect(browserJavaScript).toContain(
      "const ACTIVITY_ENDPOINT = BASE + 'model-invocations';",
    );
    expect(browserJavaScript).toContain('requestJson(ACTIVITY_ENDPOINT)');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain("setAttribute('aria-current', 'page')");
    expect(browserJavaScript).toContain("removeAttribute('aria-current')");
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only tool-call Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'tools',
      prefix: 'tool-calls',
      label: 'Tool calls',
    });
    expect(root.body).toContain('role="tablist"');
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.tool-calls-table');
    expect(css.body).toContain('.tool-call-status');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const TOOL_CALLS_ENDPOINT = BASE + 'tool-calls';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain('TOOL_CALLS_ENDPOINT,renderToolCalls,');
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain('const MAX_RECORDS = 100;');
    expect(browserJavaScript).toContain('renderToolCalls');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only worker-heartbeat Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'workers',
      prefix: 'worker-heartbeats',
      label: 'Worker heartbeats',
    });
    expect(root.body).toContain('role="tablist"');
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.worker-heartbeats-table');
    expect(css.body).toContain('.worker-heartbeat-status');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const WORKER_HEARTBEATS_ENDPOINT = BASE + 'worker-heartbeats';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain(
      'WORKER_HEARTBEATS_ENDPOINT,renderWorkerHeartbeats,',
    );
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain('const MAX_RECORDS = 100;');
    expect(browserJavaScript).toContain('renderWorkerHeartbeats');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only job Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'jobs',
      prefix: 'jobs',
      label: 'Jobs',
    });
    expect(root.body).toContain('role="tablist"');
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.jobs-table');
    expect(css.body).toContain('.job-status');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const JOBS_ENDPOINT = BASE + 'jobs';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain('JOBS_ENDPOINT,renderJobs,');
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain('const MAX_RECORDS = 100;');
    expect(browserJavaScript).toContain('normalizeJobRecord');
    expect(browserJavaScript).toContain('renderJobs');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only job-attempt Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'attempts',
      prefix: 'job-attempts',
      label: 'Job attempts',
    });
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.jobs-table');
    expect(css.body).toContain('.job-status');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const JOB_ATTEMPTS_ENDPOINT = BASE + 'job-attempts';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain(
      'JOB_ATTEMPTS_ENDPOINT,renderJobAttempts,',
    );
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain('const MAX_RECORDS = 100;');
    expect(browserJavaScript).toContain('normalizeJobAttemptRecord');
    expect(browserJavaScript).toContain('renderJobAttempts');
    expect(browserJavaScript).toContain('renderActivityRecords');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    for (const primitive of [
      'function boundedTextFields(',
      'function dateFields(',
      'function createActivityRecordCell(',
      'function renderActivityRecords(',
    ]) {
      expect(browserJavaScript).toContain(primitive);
    }
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only action-decision Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'decisions',
      prefix: 'action-decisions',
      label: 'Action decisions',
    });
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.jobs-table');
    expect(css.body).toContain('.tool-call-status');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const ACTION_DECISIONS_ENDPOINT = BASE + 'action-decisions';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain(
      'ACTION_DECISIONS_ENDPOINT,renderActionDecisions,',
    );
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain(
      "!['attention', 'pi', 'evaluator'].includes(value.decidedBy)",
    );
    expect(browserJavaScript).toContain(
      "!['low', 'medium', 'high', 'prohibited'].includes(value.riskLevel)",
    );
    expect(browserJavaScript).toContain('normalizeActionDecisionRecord');
    expect(browserJavaScript).toContain('renderActionDecisions');
    expect(browserJavaScript).toContain('renderActivityRecords');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    expect(browserJavaScript).not.toContain('record.turnId');
    expect(browserJavaScript).not.toContain('record.actions');
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only action-execution Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'executions',
      prefix: 'action-executions',
      label: 'Action executions',
    });
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.jobs-table');
    expect(css.body).toContain('.tool-call-status');
    expect(css.body).toContain('.tool-call-status-downgraded');
    expect(css.body).toContain('.tool-call-status-failed');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const ACTION_EXECUTIONS_ENDPOINT = BASE + 'action-executions';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain(
      'ACTION_EXECUTIONS_ENDPOINT,renderActionExecutions,',
    );
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain(
      "'id actionDecisionId actionType status executedMessageId executedMemoryId executedJobId downgradedFrom downgradedReason errorCode errorMessage auditLevel executedAt'.split(' ')",
    );
    expect(browserJavaScript).toContain(
      "'silent_store silent_summarize_later reply_short reply_full reply_with_tool propose_memory admin_digest schedule_background_task dm_user react_only send_folded_forward ask_clarification'.split(' ')",
    );
    expect(browserJavaScript).toContain(
      "!['success', 'downgraded', 'failed', 'rejected'].includes(value.status)",
    );
    expect(browserJavaScript).toContain(
      "!['summary', 'redacted_full', 'full'].includes(value.auditLevel)",
    );
    expect(browserJavaScript).toContain(
      "hasOwn(value, 'downgradedFrom') && !actionTypes.includes(value.downgradedFrom)",
    );
    expect(browserJavaScript).toContain("dateFields(value, ['executedAt'], false, true)");
    for (const boundedField of [
      "['executedMessageId', 256]",
      "['executedMemoryId', 256]",
      "['executedJobId', 256]",
      "['downgradedReason', 512]",
      "['errorCode', 512]",
      "['errorMessage', 512]",
    ]) {
      expect(browserJavaScript).toContain(boundedField);
    }
    expect(browserJavaScript).toContain('normalizeActionExecutionRecord');
    expect(browserJavaScript).toContain('renderActionExecutions');
    expect(browserJavaScript).toContain('renderActivityRecords');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    expect(browserJavaScript).not.toContain('auditEntry');
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only event-processing-failure Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'failures',
      prefix: 'event-processing-failures',
      label: 'Event processing failures',
    });
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.jobs-table');
    expect(css.body).toContain('.tool-call-diagnostic');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const EVENT_PROCESSING_FAILURES_ENDPOINT = BASE + 'event-processing-failures';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain(
      'EVENT_PROCESSING_FAILURES_ENDPOINT,renderEventProcessingFailures,',
    );
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain(
      "'id rawEventId turnId occurredAt stage conversationType errorName errorMessageHash messageIdHash senderIdHash conversationIdHash'.split(' ')",
    );
    expect(browserJavaScript).toContain('const HASH_PATTERN = /^[0-9a-f]{64}$/;');
    expect(browserJavaScript).toContain("['id', 256]");
    expect(browserJavaScript).toContain("['stage', 256]");
    expect(browserJavaScript).toContain("['errorName', 512]");
    expect(browserJavaScript).toContain("['rawEventId', 256]");
    expect(browserJavaScript).toContain("['turnId', 256]");
    expect(browserJavaScript).toContain("dateFields(value, ['occurredAt'], false, true)");
    expect(browserJavaScript).toContain(
      "!['private', 'group'].includes(value.conversationType)",
    );
    expect(browserJavaScript).toContain('normalizeEventProcessingFailureRecord');
    expect(browserJavaScript).toContain('renderEventProcessingFailures');
    expect(browserJavaScript).toContain('renderActivityRecords');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    expect(browserJavaScript).not.toMatch(/record\.details(?!Redacted)/);
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('exposes a fixed read-only audit Activity browser view', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activityScript = await send(harness, '/governance/activity.js');
    const browserJavaScript = script.body + '\n' + activityScript.body;

    assertFixedActivityListShell(root.body, browserJavaScript, {
      view: 'audit',
      prefix: 'audit',
      label: 'Audit',
    });
    expect(browserJavaScript).toContain("...(!isDecision ? { role: 'table' } : {})");
    expect(root.body).toContain('role="alert"');

    expect(css.body).toContain('.activity-tabs');
    expect(css.body).toContain('.jobs-table');
    expect(css.body).toContain('.tool-call-diagnostic');
    expect(css.body).toContain('@media (max-width: 760px)');

    expect(browserJavaScript).toContain(
      "const AUDIT_ENDPOINT = BASE + 'audit';",
    );
    expect(browserJavaScript.replaceAll('\n', '')).toContain(
      'AUDIT_ENDPOINT,renderAuditRecords,',
    );
    expect(browserJavaScript).toContain('request: () => requestJson(endpoint)');
    expect(browserJavaScript).toContain(
      "'id timestamp category level eventType eventId actor summary detailsRedacted redacted riskLevel evaluatorDecisionId'.split(' ')",
    );
    expect(browserJavaScript).toContain(
      "hasOnlyKeys(value.actor, ['canonicalUserId', 'actorClass', 'context'])",
    );
    for (const boundedField of [
      "['id', 256]",
      "['category', 256]",
      "['level', 256]",
      "['eventType', 256]",
      "['eventId', 256]",
      "['summary', 512]",
      "['canonicalUserId', 256]",
      "['actorClass', 256]",
      "['context', 256]",
      "['riskLevel', 256]",
      "['evaluatorDecisionId', 256]",
    ]) {
      expect(browserJavaScript).toContain(boundedField);
    }
    expect(browserJavaScript).toContain("dateFields(value, ['timestamp'], false, true)");
    expect(browserJavaScript).toContain("typeof value.detailsRedacted !== 'boolean'");
    expect(browserJavaScript).toContain("typeof value.redacted !== 'boolean'");
    expect(browserJavaScript).toContain('normalizeAuditRecord');
    expect(browserJavaScript).toContain('renderAuditRecords');
    expect(browserJavaScript).toContain('renderActivityRecords');
    expect(browserJavaScript).toContain("credentials: 'same-origin'");
    expect(browserJavaScript).toContain('document.createElement');
    expect(browserJavaScript).not.toMatch(/record\.details(?!Redacted)/);
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(browserJavaScript).not.toContain(prohibited);
    }
    expect(root.body.length + css.body.length + script.body.length).toBeLessThan(65_536);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves compact fixed browser assets with bounded extension headroom', async () => {
    const harness = await startHarness();
    const root = await send(harness, '/governance/');
    const css = await send(harness, '/governance/app.css');
    const script = await send(harness, '/governance/app.js');
    const activity = await send(harness, '/governance/activity.js');
    const assets = [root, css, script];

    expect(script.body).toContain('function bindElements(ids)');
    for (const primitive of [
      'function boundedTextFields(',
      'function dateFields(',
      'function activityValueLabel(',
      'function createActivityRecordCell(',
      'function renderActivityRecords(',
    ]) {
      expect(activity.body).toContain(primitive);
    }
    expect(assets.reduce(
      (total, asset) => total + Buffer.byteLength(asset.body, 'utf8'),
      0,
    )).toBeLessThan(65_536);
    for (const asset of [...assets, activity]) {
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
      assertSecurityHeaders(asset.headers);
      expect(asset.headers.get('set-cookie')).toBeNull();
      expect(Number(asset.headers.get('content-length'))).toBe(
        Buffer.byteLength(asset.body, 'utf8'),
      );
    }
    expect([...assets, activity].map((asset) => asset.status)).toEqual([200, 200, 200, 200]);
    expect([...assets, activity].map((asset) => asset.headers.get('content-type'))).toEqual([
      'text/html; charset=utf-8',
      'text/css; charset=utf-8',
      'text/javascript; charset=utf-8',
      'text/javascript; charset=utf-8',
    ]);

    const rootWithoutSlash = await send(harness, '/governance');
    const repeatedAssets = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
      send(harness, '/governance/activity.js'),
    ]);
    expect(rootWithoutSlash.body).toBe(root.body);
    expect(repeatedAssets.map((asset) => asset.body)).toEqual(
      [...assets, activity].map((asset) => asset.body),
    );

    const query = await send(harness, '/governance/?asset=css');
    const unknown = await send(harness, '/governance/missing.css');
    const wrongMethod = await send(harness, '/governance/app.js', { method: 'POST' });
    expect([query.status, unknown.status, wrongMethod.status]).toEqual([404, 404, 404]);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('keeps fixed Activity list shells below the permanent asset boundary', async () => {
    const harness = await startHarness();
    const assets = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
    ]);

    expect(assets.reduce(
      (total, asset) => total + Buffer.byteLength(asset.body, 'utf8'),
      0,
    )).toBeLessThan(65_536);
    expect(assets.map((asset) => asset.status)).toEqual([200, 200, 200]);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('retains compact shared Activity definitions after the Audit extension', async () => {
    const harness = await startHarness();
    const [root, css, script, activity] = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
      send(harness, '/governance/activity.js'),
    ]);
    const assets = [root, css, script];

    expect(assets.reduce(
      (total, asset) => total + Buffer.byteLength(asset.body, 'utf8'),
      0,
    )).toBeLessThan(65_536);
    for (const sharedDefinition of [
      'const MAX_RECORDS = 100;',
      'const MAX_TEXT = 256;',
      'const MAX_DIAGNOSTIC = 512;',
      "const PRIMARY = 'tool-call-primary';",
      "const SECONDARY = 'tool-call-secondary';",
      "const DIAGNOSTIC = 'tool-call-diagnostic';",
    ]) {
      expect(activity.body).toContain(sharedDefinition);
    }
    for (const legacyDefinition of [
      'MAX_TOOL_CALL_RECORDS',
      'MAX_TOOL_CALL_ID_LENGTH',
      'MAX_TOOL_CALL_TEXT_LENGTH',
      'MAX_TOOL_CALL_DIAGNOSTIC_LENGTH',
      'MAX_WORKER_HEARTBEAT_RECORDS',
      'MAX_WORKER_HEARTBEAT_TEXT_LENGTH',
      'MAX_JOB_RECORDS',
    ]) {
      expect(activity.body).not.toContain(legacyDefinition);
    }
    expect([...assets, activity].map((asset) => asset.status)).toEqual([200, 200, 200, 200]);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves fixed Activity projections from one local module', async () => {
    const harness = await startHarness();
    const [root, css, script, activity] = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
      send(harness, '/governance/activity.js'),
    ]);

    expect(activity.status).toBe(200);
    expect(activity.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    assertSecurityHeaders(activity.headers);
    expect(activity.headers.get('set-cookie')).toBeNull();
    expect(Number(activity.headers.get('content-length'))).toBe(
      Buffer.byteLength(activity.body, 'utf8'),
    );
    expect(script.body).toContain(
      "import { createActivityFeature } from '/governance/activity.js';",
    );
    expect(script.body).toContain('createActivityFeature(');
    expect(activity.body).toContain('export function createActivityFeature(');

    for (const definition of [
      "const BASE = '/governance/api/v1/activity/';",
      "const ACTIVITY_ENDPOINT = BASE + 'model-invocations';",
      "const AUDIT_ENDPOINT = BASE + 'audit';",
      'const activityListDefinitions = [',
      'function normalizeToolCallRecord(',
      'function normalizeAuditRecord(',
      'function renderActivityRecords(',
      'function renderAuditRecords(',
    ]) {
      expect(activity.body).toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    expect(script.body).not.toContain('import(');
    expect(activity.body).not.toContain('import(');
    expect(
      Buffer.byteLength(root.body, 'utf8')
        + Buffer.byteLength(css.body, 'utf8')
        + Buffer.byteLength(script.body, 'utf8'),
    ).toBeLessThan(60_000);
    for (const asset of [root, css, script, activity]) {
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves the first exact-scope read-only Memory Records browser view', async () => {
    const harness = await startHarness();
    const [root, css, script, activity, memory, presentation] = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
      send(harness, '/governance/activity.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    expect(memory.status).toBe(200);
    expect(memory.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    assertSecurityHeaders(memory.headers);
    expect(memory.headers.get('set-cookie')).toBeNull();
    expect(Number(memory.headers.get('content-length'))).toBe(
      Buffer.byteLength(memory.body, 'utf8'),
    );
    expect(script.body).toContain(
      "import { createMemoryFeature } from '/governance/memory.js';",
    );
    expect(script.body).toContain('createMemoryFeature(');
    expect(script.body).toContain("'X-LetheBot-Scope'");
    expect(memory.body).toContain('export function createMemoryFeature(');

    for (const definition of [
      "const MEMORY_SCOPES_ENDPOINT = '/governance/api/v1/memory/scopes';",
      "const MEMORY_RECORDS_ENDPOINT = '/governance/api/v1/memory/records';",
      "id: 'memory-nav'",
      "id: 'memory-view'",
      "id: 'memory-scope-select'",
      "id: 'memory-records-list'",
    ]) {
      expect(memory.body).toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const definition of [
      'function normalizeMemoryScopeCatalog(',
      'function normalizeMemoryRecordPage(',
      'function renderMemoryRecords(',
    ]) {
      expect(presentation.body).toContain(definition);
      expect(memory.body).not.toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(memory.body).not.toContain(prohibited);
    }
    expect(presentation.body).toContain('document.createElement');
    expect(memory.body).not.toContain('import(');
    expect(script.body).not.toContain('import(');
    expect(
      Buffer.byteLength(root.body, 'utf8')
        + Buffer.byteLength(css.body, 'utf8')
        + Buffer.byteLength(script.body, 'utf8'),
    ).toBeLessThan(60_000);
    for (const asset of [root, css, script, activity, memory, presentation]) {
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves a purpose-isolated read-only Memory Review queue', async () => {
    const harness = await startHarness();
    const [root, css, script, activity, memory, presentation] = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
      send(harness, '/governance/activity.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    for (const definition of [
      "const MEMORY_REVIEW_SCOPES_ENDPOINT = '/governance/api/v1/scopes';",
      "const MEMORY_REVIEWS_ENDPOINT = '/governance/api/v1/memory-reviews';",
      "id: 'memory-records-tab'",
      "id: 'memory-reviews-tab'",
      "class: 'memory-tabs'",
      "id: 'memory-review-scope-select'",
      "id: 'memory-reviews-list'",
    ]) {
      expect(memory.body).toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const definition of [
      'function normalizeMemoryReviewScopeCatalog(',
      'function normalizeMemoryReviewPage(',
      'function renderMemoryReviews(',
    ]) {
      expect(presentation.body).toContain(definition);
      expect(memory.body).not.toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    expect(script.body).toContain('let memoryReviewCatalogRequestSequence = 0;');
    expect(script.body).toContain('let memoryReviewsRequestSequence = 0;');
    expect(script.body).toContain("document.querySelector('.activity-tabs')");
    expect(memory.body).not.toContain("class: 'activity-tabs memory-tabs'");
    expect(script.body).toContain("'X-LetheBot-Scope': selected.handle");
    expect(memory.body).not.toContain('localStorage');
    expect(memory.body).not.toContain('sessionStorage');
    expect(memory.body).not.toContain('innerHTML');
    expect(memory.body).not.toContain('import(');
    expect(script.body).not.toContain('import(');
    expect(
      Buffer.byteLength(root.body, 'utf8')
        + Buffer.byteLength(css.body, 'utf8')
        + Buffer.byteLength(script.body, 'utf8'),
    ).toBeLessThan(60_000);
    for (const asset of [root, css, script, activity, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves coherent read-only Memory Review detail from current row authority', async () => {
    const harness = await startHarness();
    const [script, memory, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    for (const definition of [
      "const MEMORY_REVIEW_DETAIL_ENDPOINT = MEMORY_REVIEWS_ENDPOINT + '/';",
      "'memory-review-detail-unselected'",
      "'memory-review-detail-loading'",
      "'memory-review-detail-error'",
      "'memory-review-detail-not-found'",
      "id: 'memory-review-detail-content'",
      "id: 'memory-review-detail-candidates'",
      "id: 'memory-review-detail-revisions'",
    ]) {
      expect(memory.body).toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const definition of [
      'function normalizeMemoryReviewDetail(',
      'function renderMemoryReviewDetail(',
      "class: 'button button-secondary memory-review-detail-button'",
    ]) {
      expect(presentation.body).toContain(definition);
      expect(memory.body).not.toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const controller of [
      'let memoryReviewDetailRequestSequence = 0;',
      'async function loadMemoryReviewDetail(selected)',
      'MEMORY_REVIEW_DETAIL_ENDPOINT + selected.handle',
      'reviewsList.addEventListener',
    ]) {
      expect(memory.body).toContain(controller);
      expect(script.body).not.toContain(controller);
    }
    expect(memory.body).toContain('function clearReviewDetail(');
    expect(memory.body).toContain("'X-LetheBot-Scope': selected.scopeHandle");
    expect(script.body).toContain('memoryFeature.clearReviewDetail()');
    expect(script.body).toContain('requestJson,');
    expect(script.body).toContain('showSessionExpired,');
    expect(presentation.body).toContain('const REVIEW_DETAIL_KEYS = [');
    expect(presentation.body).toContain('const REVIEW_CANDIDATE_KEYS = [');
    expect(presentation.body).toContain('const REVIEW_REVISION_KEYS = [');
    expect(memory.body).toContain('selectedReview');
    expect(memory.body).not.toContain('data-resource-handle');
    expect(memory.body).not.toContain('localStorage');
    expect(memory.body).not.toContain('sessionStorage');
    expect(memory.body).not.toContain('innerHTML');
    expect(memory.body).not.toContain('import(');
    expect(script.body).not.toContain('import(');
    for (const asset of [script, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves coherent read-only Memory Record provenance detail from current row authority', async () => {
    const harness = await startHarness();
    const [script, memory, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    for (const definition of [
      "const MEMORY_RECORD_DETAIL_ENDPOINT = MEMORY_RECORDS_ENDPOINT + '/';",
      "'memory-record-detail-unselected'",
      "'memory-record-detail-loading'",
      "'memory-record-detail-error'",
      "'memory-record-detail-not-found'",
      "id: 'memory-record-detail-content'",
      "id: 'memory-record-detail-sources'",
      "id: 'memory-record-detail-revisions'",
      "id: 'memory-record-detail-audit'",
    ]) {
      expect(memory.body).toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const definition of [
      'function normalizeMemoryRecordDetail(',
      'function renderMemoryRecordDetail(',
      "class: 'button button-secondary memory-record-detail-button'",
    ]) {
      expect(presentation.body).toContain(definition);
      expect(memory.body).not.toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    for (const controller of [
      'let memoryRecordDetailRequestSequence = 0;',
      'async function loadMemoryRecordDetail(selected)',
      'MEMORY_RECORD_DETAIL_ENDPOINT + selected.handle',
      'list.addEventListener',
    ]) {
      expect(memory.body).toContain(controller);
      expect(script.body).not.toContain(controller);
    }
    expect(memory.body).toContain('function clearRecordDetail(');
    expect(memory.body).toContain("'X-LetheBot-Scope': selected.scopeHandle");
    expect(presentation.body).toContain('const RECORD_DETAIL_KEYS = [');
    expect(presentation.body).toContain('const RECORD_SOURCE_KEYS = [');
    expect(presentation.body).toContain('const RECORD_REVISION_KEYS = [');
    expect(presentation.body).toContain('const RECORD_AUDIT_KEYS = [');
    expect(presentation.body).toContain('recordSummariesAgree');
    expect(memory.body).toContain('selectedRecord');
    expect(memory.body).not.toContain('data-resource-handle');
    expect(memory.body).not.toContain('localStorage');
    expect(memory.body).not.toContain('sessionStorage');
    expect(memory.body).not.toContain('innerHTML');
    expect(memory.body).not.toContain('import(');
    expect(script.body).not.toContain('import(');
    for (const asset of [script, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('characterizes the complete Memory definition union across presentation extraction', async () => {
    const harness = await startHarness();
    const [
      root,
      css,
      script,
      activity,
      memory,
      recordMutations,
      application,
      transitions,
      presentation,
    ]
      = await Promise.all([
        send(harness, '/governance/'),
        send(harness, '/governance/app.css'),
        send(harness, '/governance/app.js'),
        send(harness, '/governance/activity.js'),
        send(harness, '/governance/memory.js'),
        send(harness, '/governance/memory-record-mutations.js'),
        send(harness, '/governance/memory-application.js'),
        send(harness, '/governance/memory-maintenance-transitions.js'),
        send(harness, '/governance/memory-presentation.js'),
      ]);
    const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

    expect([
      root,
      css,
      script,
      activity,
      memory,
      recordMutations,
      application,
      transitions,
      presentation,
    ].map((asset) => asset.status)).toEqual([
      200,
      200,
      200,
      200,
      200,
      200,
      200,
      200,
      200,
    ]);
    expect([
      sha256(root.body),
      sha256(css.body),
      sha256(script.body),
      sha256(activity.body),
    ]).toEqual([
      'b623c37588ef24fd14f501ce2451c44f04c4f7ea835703d591f2a509af5853cb',
      'e1cc9b82e1acfbe49457da468db816c510fb213035f6bf26cd8302fd9450d3d9',
      'fe973f6b55d903823c09a7bada49850751014ed8048411a164a3a6f0d35a281f',
      'b7730264d7a3a65e9e457f0662dd46036de6531b0c4b97001df0903513eca443',
    ]);

    let definitionUnion = memory.body;
    if (presentation.status === 200) {
      const endpointsStart = memory.body.indexOf('const MEMORY_SCOPES_ENDPOINT');
      const controllerStart = memory.body.indexOf('function createState(');
      const exportStart = presentation.body.lastIndexOf('\nexport {');
      expect(endpointsStart).toBeGreaterThan(0);
      expect(controllerStart).toBeGreaterThan(endpointsStart);
      expect(exportStart).toBeGreaterThan(0);
      const controller = memory.body.slice(endpointsStart);
      const controllerSplit = controller.indexOf('function createState(');
      definitionUnion = controller.slice(0, controllerSplit)
        + presentation.body.slice(0, exportStart)
        + '\n'
        + recordMutations.body
        + '\n'
        + application.body
        + '\n'
        + transitions.body
        + '\n'
        + controller.slice(controllerSplit);
    } else {
      expect(presentation.status).toBe(404);
    }
    expect(Buffer.byteLength(definitionUnion, 'utf8')).toBe(174_340);
    expect(sha256(definitionUnion)).toBe(
      '78dc8f7910428af2018549968ea437cb39ab2f084cb63b2ac8269217162d2013',
    );
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves Memory presentation through one static bounded module boundary', async () => {
    const harness = await startHarness();
    const [root, css, script, activity, memory, presentation] = await Promise.all([
      send(harness, '/governance/'),
      send(harness, '/governance/app.css'),
      send(harness, '/governance/app.js'),
      send(harness, '/governance/activity.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    expect.soft(presentation.status).toBe(200);
    expect.soft(Buffer.byteLength(memory.body, 'utf8')).toBeLessThan(65_536);
    if (presentation.status !== 200) return;

    expect(presentation.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    assertSecurityHeaders(presentation.headers);
    expect(presentation.headers.get('set-cookie')).toBeNull();
    expect(Number(presentation.headers.get('content-length'))).toBe(
      Buffer.byteLength(presentation.body, 'utf8'),
    );
    expect(Buffer.byteLength(presentation.body, 'utf8')).toBeLessThan(65_536);
    expect(memory.body).toContain("from '/governance/memory-presentation.js';");
    expect(memory.body.match(/from '\/governance\/memory-presentation\.js';/gu)).toHaveLength(1);
    expect(memory.body).not.toContain('import(');
    expect(presentation.body).not.toContain("from '/governance/");
    expect(presentation.body).not.toContain('import(');

    for (const definition of [
      'const MAX_ENTRIES = 100;',
      'const RECORD_KEYS = [',
      'const REVIEW_DETAIL_KEYS = [',
      'function exactObject(',
      'function normalizeMemoryScopeCatalog(',
      'function normalizeMemoryRecordPage(',
      'function normalizeMemoryRecordDetail(',
      'function recordSummariesAgree(',
      'function normalizeMemoryReviewPage(',
      'function normalizeMemoryReviewDetail(',
      'function reviewSummariesAgree(',
      'function createElement(',
      'function formatDate(',
      'function renderMemoryRecords(',
      'function renderMemoryRecordDetail(',
      'function renderMemoryReviews(',
      'function renderMemoryReviewDetail(',
    ]) {
      expect(presentation.body).toContain(definition);
      expect(memory.body).not.toContain(definition);
    }
    for (const controller of [
      "const MEMORY_SCOPES_ENDPOINT = '/governance/api/v1/memory/scopes';",
      "const MEMORY_REVIEW_DETAIL_ENDPOINT = MEMORY_REVIEWS_ENDPOINT + '/';",
      'function createState(',
      'export function createMemoryFeature(',
      'let memoryRecordDetailRequestSequence = 0;',
      'let memoryReviewDetailRequestSequence = 0;',
      'async function loadMemoryRecordDetail(',
      'async function loadMemoryReviewDetail(',
      "reviewsList.addEventListener('click'",
      "list.addEventListener('click'",
    ]) {
      expect(memory.body).toContain(controller);
      expect(presentation.body).not.toContain(controller);
    }
    for (const exported of [
      'append',
      'createElement',
      'detailTable',
      'normalizeMemoryRecordPage',
      'normalizeMemoryReviewPage',
      'normalizeMemoryReviewScopeCatalog',
      'normalizeMemoryScopeCatalog',
      'renderMemoryRecordDetail',
      'renderMemoryRecords',
      'renderMemoryReviewDetail',
      'renderMemoryReviews',
    ]) {
      expect(memory.body).toMatch(new RegExp(`\\b${exported}\\b`, 'u'));
      expect(presentation.body).toMatch(new RegExp(`\\b${exported}\\b`, 'u'));
    }
    for (const prohibited of [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
    ]) {
      expect(memory.body).not.toContain(prohibited);
      expect(presentation.body).not.toContain(prohibited);
    }
    for (const asset of [root, css, script, activity, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).toBe(asset.body.trim());
      expect(asset.body).not.toMatch(/^[ \t]+/mu);
      expect(asset.body).not.toContain('\n\n');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves a current-review approval preview without rendered confirmation authority', async () => {
    const harness = await startHarness();
    const [script, memory, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    expect(script.body).toContain('(path, scopeHandle, body) => requestJson(path, {');
    expect(script.body).toContain("'X-LetheBot-CSRF': csrfToken");
    expect(script.body).toContain("'X-LetheBot-Scope': scopeHandle");
    expect(script.body).toContain("'Content-Type': 'application/json'");
    expect(script.body).toContain('body: JSON.stringify(body)');
    for (const controller of [
      "const MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT = MEMORY_REVIEWS_ENDPOINT + '/';",
      'let memoryApprovalPreviewRequestSequence = 0;',
      "id: 'memory-review-approval-preview-button'",
      "'memory-review-approval-preview-unrequested'",
      "'memory-review-approval-preview-loading'",
      "'memory-review-approval-preview-malformed'",
      "'memory-review-approval-preview-unavailable'",
      "'memory-review-approval-preview-not-found'",
      "'memory-review-approval-preview-stale'",
      "id: 'memory-review-approval-preview-populated'",
      'async function loadMemoryApprovalPreview(selected)',
      'MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + selected.handle',
      "{ action: 'approve' }",
    ]) {
      expect(memory.body).toContain(controller);
      expect(script.body).not.toContain(controller);
    }
    for (const presentationDefinition of [
      'const APPROVAL_PREVIEW_KEYS = [',
      'const APPROVAL_DURABLE_EFFECTS = [',
      'function normalizeMemoryApprovalPreview(',
      'function renderMemoryApprovalPreview(',
      "action: 'memory.maintenance.review.approve'",
      "boundary: 'approval_does_not_apply_memory_effects'",
    ]) {
      expect(presentation.body).toContain(presentationDefinition);
      expect(memory.body).not.toContain(presentationDefinition);
      expect(script.body).not.toContain(presentationDefinition);
    }
    expect(presentation.body).toContain("'previewHandle'");
    expect(presentation.body).toContain("'previewDigest'");
    expect(presentation.body).toContain("'previewExpiresAt'");
    expect(memory.body).toContain('previewHandle');
    expect(memory.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('previewHandle');
    expect(script.body).not.toContain('previewDigest');
    for (const asset of [script, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(script.body).not.toContain('/confirm');
    expect(presentation.body).not.toContain('/confirm');
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('confirms a coherent current-review approval through private browser authority', async () => {
    const harness = await startHarness();
    const [script, memory, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    expect(script.body).toContain('(path, scopeHandle, body) => requestJson(path, {');
    expect(script.body).toContain("'X-LetheBot-CSRF': csrfToken");
    expect(script.body).toContain("'X-LetheBot-Scope': scopeHandle");
    for (const controller of [
      "const MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX = '/confirm';",
      'let memoryApprovalConfirmationRequestSequence = 0;',
      'let approvalConfirmationAuthority = null;',
      "id: 'memory-review-approval-confirm-button'",
      "'memory-review-approval-confirming'",
      "'memory-review-approval-succeeded'",
      "'memory-review-approval-confirm-malformed'",
      "'memory-review-approval-confirm-unavailable'",
      "'memory-review-approval-confirm-not-found'",
      "'memory-review-approval-confirm-conflict'",
      'async function confirmMemoryApproval()',
      'MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX',
      '{ confirm: true, previewHandle: authority.previewHandle }',
    ]) {
      expect(memory.body).toContain(controller);
      expect(script.body).not.toContain(controller);
    }
    for (const presentationDefinition of [
      'const APPROVAL_CONFIRMATION_KEYS = [',
      'function normalizeMemoryApprovalConfirmation(',
      'function renderMemoryApprovalConfirmation(',
      "outcome: 'approved'",
      "transition: 'approve'",
      "boundary: 'approval_does_not_apply_memory_effects'",
    ]) {
      expect(presentation.body).toContain(presentationDefinition);
      expect(memory.body).not.toContain(presentationDefinition);
      expect(script.body).not.toContain(presentationDefinition);
    }
    expect(memory.body).toContain('renderMemoryApprovalConfirmation,');
    expect(memory.body).toContain('approvalConfirmationAuthority = null;');
    expect(memory.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('previewHandle');
    expect(script.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('/confirm');
    expect(presentation.body).not.toContain("MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX");
    for (const asset of [script, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('previews a coherent current-review rejection without rendering confirmation authority', async () => {
    const harness = await startHarness();
    const [script, memory, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    expect(script.body).toContain('(path, scopeHandle, body) => requestJson(path, {');
    expect(script.body).toContain("'X-LetheBot-CSRF': csrfToken");
    expect(script.body).toContain("'X-LetheBot-Scope': scopeHandle");
    for (const controller of [
      'let memoryRejectionPreviewRequestSequence = 0;',
      "id: 'memory-review-rejection-preview-button'",
      "'memory-review-rejection-preview-unrequested'",
      "'memory-review-rejection-preview-loading'",
      "'memory-review-rejection-preview-malformed'",
      "'memory-review-rejection-preview-unavailable'",
      "'memory-review-rejection-preview-not-found'",
      "'memory-review-rejection-preview-stale'",
      "id: 'memory-review-rejection-preview-populated'",
      'async function loadMemoryRejectionPreview(selected)',
      'MEMORY_REVIEW_APPROVAL_PREVIEW_ENDPOINT + selected.handle',
      "{ action: 'reject' }",
    ]) {
      expect(memory.body).toContain(controller);
      expect(script.body).not.toContain(controller);
    }
    for (const presentationDefinition of [
      'function normalizeMemoryRejectionPreview(',
      'function renderMemoryRejectionPreview(',
      "action: 'memory.maintenance.review.reject'",
      "boundary: 'rejection_does_not_apply_memory_effects'",
    ]) {
      expect(presentation.body).toContain(presentationDefinition);
      expect(memory.body).not.toContain(presentationDefinition);
      expect(script.body).not.toContain(presentationDefinition);
    }
    expect(memory.body).toContain('renderMemoryRejectionPreview,');
    expect(memory.body).toContain('clearApprovalConfirmationAuthority();');
    expect(memory.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('previewHandle');
    expect(script.body).not.toContain('previewDigest');
    for (const asset of [script, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('confirms a coherent current-review rejection through private browser authority', async () => {
    const harness = await startHarness();
    const [script, memory, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    expect(script.body).toContain('(path, scopeHandle, body) => requestJson(path, {');
    expect(script.body).toContain("'X-LetheBot-CSRF': csrfToken");
    expect(script.body).toContain("'X-LetheBot-Scope': scopeHandle");
    for (const controller of [
      'let memoryRejectionConfirmationRequestSequence = 0;',
      'let rejectionConfirmationAuthority = null;',
      "id: 'memory-review-rejection-confirm-button'",
      "'memory-review-rejection-confirming'",
      "'memory-review-rejection-succeeded'",
      "'memory-review-rejection-confirm-malformed'",
      "'memory-review-rejection-confirm-unavailable'",
      "'memory-review-rejection-confirm-not-found'",
      "'memory-review-rejection-confirm-conflict'",
      'async function confirmMemoryRejection()',
      'MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX',
      "{ confirm: true, previewHandle: authority.previewHandle, action: 'reject' }",
    ]) {
      expect(memory.body).toContain(controller);
      expect(script.body).not.toContain(controller);
    }
    for (const presentationDefinition of [
      'function normalizeMemoryRejectionConfirmation(',
      'function renderMemoryRejectionConfirmation(',
      "outcome: 'rejected'",
      "transition: 'reject'",
      "boundary: 'rejection_does_not_apply_memory_effects'",
    ]) {
      expect(presentation.body).toContain(presentationDefinition);
      expect(memory.body).not.toContain(presentationDefinition);
      expect(script.body).not.toContain(presentationDefinition);
    }
    expect(memory.body).toContain('renderMemoryRejectionConfirmation,');
    expect(memory.body).toContain('rejectionConfirmationAuthority = null;');
    expect(memory.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('previewHandle');
    expect(script.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('/confirm');
    expect(presentation.body).not.toContain('MEMORY_REVIEW_APPROVAL_CONFIRM_SUFFIX');
    for (const asset of [script, memory, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('previews and confirms approved maintenance application through private authority', async () => {
    const harness = await startHarness();
    const [script, memory, application, presentation] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-application.js'),
      send(harness, '/governance/memory-presentation.js'),
    ]);

    for (const controller of [
      "from '/governance/memory-application.js';",
      "id: 'memory-review-application-preview-button'",
      "id: 'memory-review-retained-memory-select'",
      "id: 'memory-review-application-preview-populated'",
    ]) expect(memory.body + presentation.body).toContain(controller);
    for (const controller of [
      'let previewSequence = 0;',
      'let confirmationSequence = 0;',
      'let authority = null;',
      'async function preview()',
      'async function confirm()',
      "action: 'apply'",
      'confirm: true',
      'previewHandle: current.previewHandle',
      "id: 'memory-review-application-confirmation-button'",
      "'memory-review-application-confirmation-confirming'",
      "'memory-review-application-confirmation-succeeded'",
      "'memory-review-application-confirmation-malformed'",
      "'memory-review-application-confirmation-unavailable'",
      "'memory-review-application-confirmation-not-found'",
      "'memory-review-application-confirmation-conflict'",
    ]) expect(application.body).toContain(controller);
    for (const definition of [
      'const APPLICATION_PREVIEW_KEYS = [',
      'const APPLICATION_DURABLE_EFFECTS = [',
      'function normalizeMemoryApplicationPreview(',
      'function renderMemoryApplicationPreview(',
      "value.action !== 'memory.maintenance.apply'",
      "value.rollback.boundary !== 'separate_confirmation_required'",
    ]) {
      expect(presentation.body).toContain(definition);
      expect(script.body).not.toContain(definition);
    }
    expect(application.body).toContain('renderMemoryApplicationPreview,');
    expect(application.body).not.toContain('previewDigest');
    expect(memory.body).not.toContain('previewDigest');
    expect(script.body).not.toContain('previewHandle');
    expect(script.body).not.toContain('retainedMemoryRef');
    for (const asset of [script, memory, application, presentation]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves bounded unscoped Identity and Operations controls', async () => {
    const harness = await startHarness();
    const [script, administration, retention] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/administration.js'),
      send(harness, '/governance/retention.js'),
    ]);

    expect(script.body).toContain("from '/governance/administration.js';");
    expect(administration.body).toContain("from '/governance/retention.js';");
    expect(script.body).toContain('const unscopedMutation = (path, body) => requestJson(path, {');
    for (const definition of [
      'createIdentityFeature',
      'createOperationsFeature',
      "const UNLINK_ENDPOINT = '/governance/api/v1/identity/platform-accounts/unlink'",
      "const OPERATIONS_ENDPOINT = '/governance/api/v1/operations'",
      "{ action: 'unlink', platform: 'qq', platformAccountId }",
      "{ confirm: true, resourceHandle: retained.resourceHandle, previewHandle: retained.previewHandle }",
      "{ action: 'create_verified_backup' }",
      "{ action: 'prepare_restore_handoff', backupRef }",
      "'stopped_service_only'",
      "type: 'password'",
      "id: 'identity-confirm-button'",
      'id: \'operations-confirm-button\'',
    ]) expect(administration.body).toContain(definition);
    for (const definition of [
      'createRetentionPanel',
      "const ENDPOINT = '/governance/api/v1/operations/retention'",
      "{ action: 'apply_configured_retention' }",
      "{ confirm: true, previewHandle: retained.handle }",
      'rejected / disabled / deleted',
      'Hard-delete terminal memory',
    ]) expect(retention.body).toContain(definition);
    expect(script.body).not.toContain("'X-LetheBot-Scope': scopeHandle,\n},\nbody: JSON.stringify(body),\n});\nconst identityFeature");
    for (const asset of [script, administration, retention]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves bounded Display-profile redaction controls', async () => {
    const harness = await startHarness();
    const [script, displayProfile] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/display-profile.js'),
    ]);

    expect(script.body).toContain("from '/governance/display-profile.js';");
    for (const definition of [
      'createDisplayProfileFeature',
      "const SCOPES_ENDPOINT = '/governance/api/v1/display-profile/scopes'",
      "const TARGETS_ENDPOINT = '/governance/api/v1/display-profile/targets'",
      "{ action: 'redact' }",
      "{ confirm: true, previewHandle: retained.handle }",
      "'redacted_display_values_are_not_recoverable'",
      'value.openNicknameHistoryRowsClosed > value.affectedRows.nicknameHistory',
      '!date(value.redactedAt)',
      'previewButton.disabled = !selectedDetail',
      "id: 'display-profile-confirm-button'",
      'authority = null',
      'window.clearTimeout(timer)',
    ]) expect(displayProfile.body).toContain(definition);
    for (const asset of [script, displayProfile]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves bounded Group-summary policy preview-confirmation controls', async () => {
    const harness = await startHarness();
    const [script, groupSummary] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/group-summary.js'),
    ]);

    expect(script.body).toContain("from '/governance/group-summary.js';");
    for (const definition of [
      'createGroupSummaryFeature',
      "const SCOPES_ENDPOINT = '/governance/api/v1/group-summary/scopes'",
      "const POLICY_ENDPOINT = '/governance/api/v1/group-summary/policy'",
      "{ action: 'change', targetState }",
      "{ confirm: true, previewHandle: retained.handle, targetState: retained.target }",
      "'group.summary_policy.change'",
      "'separate_group_summary_policy_change_confirmation_required'",
      "id: 'group-summary-confirm-button'",
      'authority = null',
      'window.clearTimeout(timer)',
    ]) expect(groupSummary.body).toContain(definition);
    for (const asset of [script, groupSummary]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves bounded Privacy preview-confirmation controls', async () => {
    const harness = await startHarness();
    const [script, privacy] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/privacy.js'),
    ]);

    expect(script.body).toContain("from '/governance/privacy.js';");
    for (const definition of [
      'createPrivacyFeature',
      "const SCOPES_ENDPOINT = '/governance/api/v1/privacy/scopes'",
      "const PREFERENCES_ENDPOINT = '/governance/api/v1/privacy/preferences'",
      "{ action: 'change', preferenceType, targetState }",
      "{ confirm: true, previewHandle: retained.handle, preferenceType: retained.type, targetState: retained.target }",
      "'separate_preference_change_confirmation_required'",
      "id: 'privacy-confirm-button'",
      'authority = null',
      'window.clearTimeout(timer)',
    ]) expect(privacy.body).toContain(definition);
    expect(privacy.body).toContain('handle: normalized.previewHandle');
    for (const asset of [script, privacy]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('serves bounded read-only Explain browser evidence', async () => {
    const harness = await startHarness();
    const [script, explain] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/explain.js'),
    ]);

    expect(script.body).toContain("from '/governance/explain.js';");
    for (const definition of [
      'createExplainFeature',
      "const SCOPES_ENDPOINT = '/governance/api/v1/explain/scopes'",
      "const TURNS_ENDPOINT = '/governance/api/v1/explain/turns'",
      "headers: { 'X-LetheBot-Scope': scope.handle }",
      'normalizeCatalog(response.body, Date.now())',
      'normalizePage(response.body, Date.now())',
      'normalizeDetail(response.body, turn)',
      "id: 'explain-refresh-button'",
      "id: 'explain-detail-content'",
    ]) expect(explain.body).toContain(definition);
    for (const asset of [script, explain]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes Privacy, Group-summary, and Display-profile controllers in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(
          client,
          sessionId,
          'new Promise((resolve) => setTimeout(resolve, 250))',
        );
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const mount = () => {
            const navigation = document.createElement('nav');
            const activityNav = document.createElement('button');
            const main = document.createElement('main');
            const activityView = document.createElement('section');
            navigation.append(activityNav);
            main.append(activityView);
            document.body.replaceChildren(navigation, main);
            return { navigation, activityNav, main, activityView };
          };
          const flush = async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));
          };
          const now = Date.now();
          const timestamp = new Date(now - 1000).toISOString();
          const expiresAt = now + 600000;
          const digest = 'd'.repeat(64);
          const setHidden = (element, hidden) => { element.hidden = hidden; };

          const privacyModule = await import('/governance/privacy.js');
          const privacyElements = mount();
          const privacyScope = 'P'.repeat(43);
          const privacyPreview = 'Q'.repeat(43);
          const privacyCalls = [];
          const privacyFeature = privacyModule.createPrivacyFeature(
            privacyElements,
            setHidden,
            async (path, init) => {
              privacyCalls.push({ kind: 'read', path, scope: init?.headers?.['X-LetheBot-Scope'] || null });
              if (path.endsWith('/scopes')) return { status: 200, body: { entries: [{
                fingerprint: 'a'.repeat(16), scopeKind: 'user', label: 'User privacy',
                handle: privacyScope, expiresAt,
              }], truncated: false } };
              return { status: 200, body: { entries: [{
                preferenceType: 'memory_association', state: 'opted_out',
                createdAt: timestamp, updatedAt: timestamp,
              }], truncated: false } };
            },
            async (path, scope, body) => {
              privacyCalls.push({ kind: 'mutation', path, scope, body });
              if (!path.endsWith('/confirm')) return { status: 201, body: {
                action: 'privacy.preference.change', preferenceType: 'memory_association',
                current: { state: 'opted_out', version: { source: 'stored_preference', updatedAt: now - 1 } },
                expected: { state: 'opted_in', durableEffects: ['privacy_preference_upsert', 'audit_event_append'], enforcementConsequences: ['preference_enforced_immediately'] },
                rollback: { supported: true, targetState: 'opted_out', boundary: 'separate_preference_change_confirmation_required' },
                previewDigest: digest, previewHandle: privacyPreview, previewExpiresAt: expiresAt,
              } };
              return { status: 200, body: {
                action: 'privacy.preference.change', outcome: 'updated', preferenceType: 'memory_association',
                current: { state: 'opted_in', version: { source: 'stored_preference', updatedAt: now } },
                durableEffects: ['privacy_preference_upsert', 'audit_event_append'], enforcementConsequences: ['preference_enforced_immediately'],
                evidence: { auditEvent: 'privacy.preference_set', updatedAt: now },
                rollback: { supported: true, targetState: 'opted_out', boundary: 'separate_preference_change_confirmation_required' },
              } };
            },
            () => {},
            () => {},
          );
          await privacyFeature.load();
          document.getElementById('privacy-scope-select').value = '1';
          document.getElementById('privacy-scope-select').dispatchEvent(new Event('change'));
          await flush();
          document.getElementById('privacy-type-select').value = 'memory_association';
          document.getElementById('privacy-target-select').value = 'opted_in';
          document.getElementById('privacy-preview-button').click();
          await flush();
          document.getElementById('privacy-confirm-button').click();
          await flush();
          const privacyResult = {
            mutations: privacyCalls.filter((call) => call.kind === 'mutation'),
            success: !document.getElementById('privacy-success').hidden,
            leaked: document.body.textContent.includes(privacyScope)
              || document.body.textContent.includes(privacyPreview)
              || document.body.textContent.includes(digest),
          };

          const groupModule = await import('/governance/group-summary.js');
          const groupElements = mount();
          const groupScope = 'G'.repeat(43);
          const groupPreview = 'H'.repeat(43);
          const groupCalls = [];
          const groupEffects = ['group_summary_policy_upsert', 'audit_event_append'];
          const groupConsequences = ['policy_generation_advanced', 'pre_enable_sources_excluded', 'group_summary_generation_and_retrieval_enabled'];
          const groupFeature = groupModule.createGroupSummaryFeature(
            groupElements,
            setHidden,
            async (path, init) => {
              groupCalls.push({ kind: 'read', path, scope: init?.headers?.['X-LetheBot-Scope'] || null });
              if (path.endsWith('/scopes')) return { status: 200, body: { entries: [{
                fingerprint: 'b'.repeat(16), scopeKind: 'group', label: 'Group summary policy',
                handle: groupScope, expiresAt,
              }], truncated: false } };
              return { status: 200, body: {
                state: 'disabled', stored: true, generation: 2, eligibleAfter: null,
                createdAt: timestamp, updatedAt: timestamp,
              } };
            },
            async (path, scope, body) => {
              groupCalls.push({ kind: 'mutation', path, scope, body });
              if (!path.endsWith('/confirm')) return { status: 201, body: {
                action: 'group.summary_policy.change',
                current: { state: 'disabled', stored: true, version: { generation: 2, updatedAt: timestamp } },
                expected: { state: 'enabled', generation: 3, durableEffects: groupEffects, enforcementConsequences: groupConsequences },
                rollback: { supported: true, targetState: 'disabled', boundary: 'separate_group_summary_policy_change_confirmation_required' },
                previewDigest: digest, previewHandle: groupPreview, previewExpiresAt: expiresAt,
              } };
              return { status: 200, body: {
                action: 'group.summary_policy.change', outcome: 'updated',
                current: { state: 'enabled', stored: true, version: { generation: 3, updatedAt: timestamp }, eligibleAfter: timestamp },
                durableEffects: groupEffects, enforcementConsequences: groupConsequences,
                evidence: { auditEvent: 'group.summary_policy_changed', generation: 3, updatedAt: timestamp, canceledJobCount: 0 },
                rollback: { supported: true, targetState: 'disabled', boundary: 'separate_group_summary_policy_change_confirmation_required' },
              } };
            },
            () => {},
            () => {},
          );
          await groupFeature.load();
          document.getElementById('group-summary-scope-select').value = '1';
          document.getElementById('group-summary-scope-select').dispatchEvent(new Event('change'));
          await flush();
          document.getElementById('group-summary-target-select').value = 'enabled';
          document.getElementById('group-summary-preview-button').click();
          await flush();
          document.getElementById('group-summary-confirm-button').click();
          await flush();
          const groupResult = {
            mutations: groupCalls.filter((call) => call.kind === 'mutation'),
            success: !document.getElementById('group-summary-success').hidden,
            leaked: document.body.textContent.includes(groupScope)
              || document.body.textContent.includes(groupPreview)
              || document.body.textContent.includes(digest),
          };

          const displayModule = await import('/governance/display-profile.js');
          const displayElements = mount();
          const displayScope = 'D'.repeat(43);
          const displayTarget = 'T'.repeat(43);
          const displayPreview = 'V'.repeat(43);
          const displayCalls = [];
          const targetProjection = {
            fingerprint: 'c'.repeat(16), targetKind: 'group', label: 'Group display data',
            currentProfile: { present: true, trust: 'user_set', observedAt: timestamp },
            history: { count: 1, truncated: false, lifecycle: 'open', latestObservedAt: timestamp },
          };
          const displayEffects = ['display_profile_rows_redacted', 'nickname_history_rows_redacted', 'open_nickname_history_rows_closed', 'audit_event_append'];
          const displayConsequences = ['display_values_enforced_as_redacted', 'open_history_intervals_closed'];
          const displayFeature = displayModule.createDisplayProfileFeature(
            displayElements,
            setHidden,
            async (path, init) => {
              displayCalls.push({ kind: 'read', path, scope: init?.headers?.['X-LetheBot-Scope'] || null });
              if (path.endsWith('/scopes')) return { status: 200, body: { entries: [{
                fingerprint: 'd'.repeat(16), scopeKind: 'user', label: 'Display profile user',
                handle: displayScope, expiresAt,
              }], truncated: false } };
              if (path.endsWith('/targets')) return { status: 200, body: { entries: [{
                ...targetProjection, handle: displayTarget, handleExpiresAt: expiresAt,
              }], truncated: false } };
              return { status: 200, body: {
                target: targetProjection,
                currentDisplay: { value: 'Bounded display', redacted: false, truncated: false },
                nicknameHistory: [{ value: 'Earlier display', redacted: false, truncated: false, fingerprint: 'e'.repeat(16), observedAt: timestamp, observedUntil: null }],
                nicknameHistoryTruncated: false,
              } };
            },
            async (path, scope, body) => {
              displayCalls.push({ kind: 'mutation', path, scope, body });
              if (!path.endsWith('/confirm')) return { status: 201, body: {
                action: 'display_profile.redact', target: targetProjection,
                current: { displayProfileRows: 1, nicknameHistoryRows: 1, openNicknameHistoryRows: 1, snapshotFingerprint: digest },
                expected: { affectedRows: { displayProfiles: 1, nicknameHistory: 1, total: 2 }, durableEffects: displayEffects, privacyConsequences: displayConsequences },
                rollback: { supported: false, boundary: 'redacted_display_values_are_not_recoverable' },
                previewDigest: digest, previewHandle: displayPreview, previewExpiresAt: expiresAt,
              } };
              return { status: 200, body: {
                action: 'display_profile.redact', outcome: 'redacted', target: targetProjection,
                affectedRows: { displayProfiles: 1, nicknameHistory: 1, total: 2 }, openNicknameHistoryRowsClosed: 1,
                redactedAt: timestamp, durableEffects: displayEffects, privacyConsequences: displayConsequences,
                evidence: { auditEvent: 'display_profile.redact', reasonCode: 'governance_http_display_profile_redaction_confirmed' },
                rollback: { supported: false, boundary: 'redacted_display_values_are_not_recoverable' },
              } };
            },
            () => {},
            () => {},
          );
          await displayFeature.load();
          document.getElementById('display-profile-scope-select').value = '1';
          document.getElementById('display-profile-scope-select').dispatchEvent(new Event('change'));
          await flush();
          document.querySelector('[data-display-index]').click();
          await flush();
          document.getElementById('display-profile-preview-button').click();
          await flush();
          document.getElementById('display-profile-confirm-button').click();
          await flush();
          const displayResult = {
            mutations: displayCalls.filter((call) => call.kind === 'mutation'),
            success: !document.getElementById('display-profile-success').hidden,
            leaked: document.body.textContent.includes(displayScope)
              || document.body.textContent.includes(displayTarget)
              || document.body.textContent.includes(displayPreview)
              || document.body.textContent.includes(digest),
          };
          return JSON.stringify({ privacyResult, groupResult, displayResult });
        })()`);
        expect(JSON.parse(String(result))).toEqual({
          privacyResult: {
            mutations: [
              {
                kind: 'mutation',
                path: '/governance/api/v1/privacy/preferences',
                scope: 'P'.repeat(43),
                body: {
                  action: 'change',
                  preferenceType: 'memory_association',
                  targetState: 'opted_in',
                },
              },
              {
                kind: 'mutation',
                path: '/governance/api/v1/privacy/preferences/confirm',
                scope: 'P'.repeat(43),
                body: {
                  confirm: true,
                  previewHandle: 'Q'.repeat(43),
                  preferenceType: 'memory_association',
                  targetState: 'opted_in',
                },
              },
            ],
            success: true,
            leaked: false,
          },
          groupResult: {
            mutations: [
              {
                kind: 'mutation',
                path: '/governance/api/v1/group-summary/policy',
                scope: 'G'.repeat(43),
                body: { action: 'change', targetState: 'enabled' },
              },
              {
                kind: 'mutation',
                path: '/governance/api/v1/group-summary/policy/confirm',
                scope: 'G'.repeat(43),
                body: {
                  confirm: true,
                  previewHandle: 'H'.repeat(43),
                  targetState: 'enabled',
                },
              },
            ],
            success: true,
            leaked: false,
          },
          displayResult: {
            mutations: [
              {
                kind: 'mutation',
                path: `/governance/api/v1/display-profile/targets/${'T'.repeat(43)}`,
                scope: 'D'.repeat(43),
                body: { action: 'redact' },
              },
              {
                kind: 'mutation',
                path: `/governance/api/v1/display-profile/targets/${'T'.repeat(43)}/confirm`,
                scope: 'D'.repeat(43),
                body: { confirm: true, previewHandle: 'V'.repeat(43) },
              },
            ],
            success: true,
            leaked: false,
          },
        });
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes read-only Explain catalog and detail in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(
          client,
          sessionId,
          'new Promise((resolve) => setTimeout(resolve, 250))',
        );
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const module = await import('/governance/explain.js');
          const navigation = document.createElement('nav');
          const activityNav = document.createElement('button');
          const main = document.createElement('main');
          const activityView = document.createElement('section');
          navigation.append(activityNav);
          main.append(activityView);
          document.body.replaceChildren(navigation, main);
          const now = Date.now();
          const timestamp = new Date(now - 1000).toISOString();
          const scopeHandle = 'S'.repeat(43);
          const turnHandle = 'T'.repeat(43);
          const calls = [];
          const catalog = { entries: [{
            fingerprint: 'a'.repeat(16),
            scopeKind: 'conversation',
            conversationType: 'private',
            label: 'Private conversation',
            handle: scopeHandle,
            expiresAt: now + 600000,
          }], truncated: false };
          const turn = {
            fingerprint: 'b'.repeat(16),
            label: 'Turn',
            traceSource: 'stored',
            status: 'completed',
            startedAt: timestamp,
            completedAt: timestamp,
            handle: turnHandle,
            handleExpiresAt: now + 600000,
          };
          const detail = {
            turn: {
              fingerprint: turn.fingerprint,
              label: 'Turn',
              traceSource: 'stored',
              status: 'completed',
              startedAt: timestamp,
              completedAt: timestamp,
            },
            context: {
              traceSource: 'stored',
              candidateMemoryCount: 2,
              selectedMemoryCount: 1,
              rejectedMemoryCount: 1,
              recentMessageCount: 3,
              includedMemoryCount: 1,
              filters: [{ label: 'scope', redacted: false, truncated: false }],
              filtersTruncated: false,
              injectedIdentityFields: [],
              injectedIdentityFieldsTruncated: false,
              tokenBudget: {
                max: 100,
                used: 50,
                breakdown: { recentMessages: 20, memory: 20, identity: 0, system: 10 },
              },
            },
            actionDecision: {
              decidedBy: 'pi',
              riskLevel: 'low',
              confidence: 0.8,
              evaluatorRequired: false,
              actionCount: 1,
              actionTypes: ['reply'],
              actionTypesTruncated: false,
              reasonCount: 1,
              suppressorCount: 0,
              executions: [],
              executionsTruncated: false,
            },
            tools: [],
            toolsTruncated: false,
          };
          const feature = module.createExplainFeature(
            { navigation, activityNav, main, activityView },
            (element, hidden) => { element.hidden = hidden; },
            async (path, init) => {
              calls.push({ path, scope: init?.headers?.['X-LetheBot-Scope'] || null });
              if (path.endsWith('/scopes')) return { status: 200, body: catalog };
              if (path.endsWith('/turns')) return { status: 200, body: { entries: [turn], truncated: false } };
              return { status: 200, body: detail };
            },
            () => {},
            () => {},
          );
          await feature.load();
          const select = document.getElementById('explain-scope-select');
          select.value = '1';
          select.dispatchEvent(new Event('change'));
          await Promise.resolve();
          await Promise.resolve();
          document.querySelector('[data-explain-index]').click();
          await Promise.resolve();
          await Promise.resolve();
          return JSON.stringify({
            calls,
            navBeforeActivity: feature.nav.nextElementSibling === activityNav,
            detailVisible: !document.getElementById('explain-detail-content').hidden,
            evidence: document.getElementById('explain-detail-content').textContent,
            leakedScopeHandle: document.body.textContent.includes(scopeHandle),
            leakedTurnHandle: document.body.textContent.includes(turnHandle),
            external: calls.some((call) => !call.path.startsWith('/governance/api/v1/explain/')),
          });
        })()`);
        expect(JSON.parse(String(result))).toEqual({
          calls: [
            { path: '/governance/api/v1/explain/scopes', scope: null },
            { path: '/governance/api/v1/explain/turns', scope: 'S'.repeat(43) },
            { path: `/governance/api/v1/explain/turns/${'T'.repeat(43)}`, scope: 'S'.repeat(43) },
          ],
          navBeforeActivity: true,
          detailVisible: true,
          evidence: expect.stringContaining('1 selected / 2 candidates'),
          leakedScopeHandle: false,
          leakedTurnHandle: false,
          external: false,
        });
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it('serves bounded memory record mutation authority', async () => {
    const harness = await startHarness();
    const [script, memory, mutations] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-record-mutations.js'),
    ]);

    expect(memory.body).toContain(
      "from '/governance/memory-record-mutations.js';",
    );
    for (const definition of [
      'createMemoryRecordMutationWorkflow',
      'MEMORY_RECORD_FORGET_WORKFLOW',
      'MEMORY_RECORD_RESTORE_WORKFLOW',
      "action: 'memory.record.forget'",
      "action: 'memory.record.restore'",
      "requestAction: 'forget'",
      "requestAction: 'restore'",
      "previewBoundary: 'separate_restore_confirmation_required'",
      "previewBoundary: 'separate_forget_confirmation_required'",
      'confirmBody: (previewHandle) => ({ confirm: true, previewHandle })',
      "confirmBody: (previewHandle) => ({ confirm: true, previewHandle, action: 'restore' })",
      'if (expiryTimer !== null) window.clearTimeout(expiryTimer);',
    ]) expect(mutations.body).toContain(definition);
    expect(memory.body).toContain('forgetWorkflow?.clear(preserveResult);');
    expect(memory.body).toContain('restoreWorkflow?.clear(preserveResult);');
    expect(script.body).not.toContain('previewHandle');
    for (const asset of [script, memory, mutations]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes memory record mutation controllers in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(
          client,
          sessionId,
          'new Promise((resolve) => setTimeout(resolve, 250))',
        );
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const module = await import('/governance/memory-record-mutations.js');
          async function run(mode) {
            const forget = mode === 'forget';
            const config = forget
              ? module.MEMORY_RECORD_FORGET_WORKFLOW
              : module.MEMORY_RECORD_RESTORE_WORKFLOW;
            const parent = document.createElement('section');
            document.body.replaceChildren(parent);
            const now = Date.now();
            const previewHandle = (forget ? 'P' : 'Q').repeat(43);
            const selected = {
              recordRef: (forget ? 'a' : 'b').repeat(16),
              scopeKind: 'system',
              state: forget ? 'active' : 'deleted',
              revisionCount: 2,
              handle: (forget ? 'R' : 'S').repeat(43),
              handleExpiresAt: now + 600000,
              scopeHandle: (forget ? 'T' : 'U').repeat(43),
              scopeFingerprint: (forget ? 'c' : 'd').repeat(16),
              scopeExpiresAt: now + 600000,
            };
            const detail = { record: { ...selected } };
            const projectedRef = (forget ? 'e' : 'f').repeat(16);
            const expectedState = forget ? 'deleted' : 'active';
            const consequence = forget
              ? 'deleted_record_excluded' : 'restored_records_included';
            const boundary = forget
              ? 'separate_restore_confirmation_required'
              : 'separate_forget_confirmation_required';
            const preview = {
              action: forget ? 'memory.record.forget' : 'memory.record.restore',
              recordRef: projectedRef,
              scopeKind: 'system',
              current: { lifecycleState: selected.state, revisionNumber: 2 },
              expected: {
                lifecycleState: expectedState,
                revisionNumber: 3,
                durableEffects: ['memory_record_state_transition',
                  'memory_revision_append', 'audit_event_append'],
                retrievalConsequences: [consequence],
              },
              rollback: { supported: true, boundary },
              previewDigest: '1'.repeat(64),
              previewHandle,
              previewExpiresAt: now + 300000,
            };
            const confirmation = {
              action: preview.action,
              outcome: forget ? 'forgotten' : 'restored',
              recordRef: projectedRef,
              scopeKind: 'system',
              current: { lifecycleState: expectedState, revisionNumber: 3 },
              durableEffects: [...preview.expected.durableEffects],
              retrievalConsequences: [consequence],
              evidence: {
                changeType: forget ? 'delete' : 'restore',
                revisionNumber: 3,
                auditEvent: forget ? 'memory.delete' : 'memory.restore',
              },
              rollback: { supported: true, boundary },
            };
            const responses = [
              { status: 503, body: {} },
              { status: 404, body: {} },
              { status: 409, body: {} },
              { status: 200, body: { ...confirmation, unexpected: true } },
              { status: 200, body: confirmation },
            ];
            const calls = [];
            let responseIndex = 0;
            const workflow = module.createMemoryRecordMutationWorkflow(config, {
              parent,
              setHidden: (element, hidden) => { element.hidden = hidden; },
              request: async (handle, scope, body, confirm) => {
                calls.push({ handle, scope, body, ...(confirm ? { confirm: true } : {}) });
                return confirm ? responses[responseIndex++] : { status: 201, body: preview };
              },
              showSessionExpired: () => {},
              announce: () => {},
              getCurrent: () => ({ selected, detail }),
              onStateChange: () => {},
              onBeforePreview: () => {},
              onSuccess: () => {},
            });
            workflow.update();
            const previewButton = document.getElementById(
              'memory-record-' + mode + '-preview-button',
            );
            const confirmButton = document.getElementById(
              'memory-record-' + mode + '-confirmation-button',
            );
            const stateIds = ['result-unavailable', 'result-not-found', 'conflict',
              'result-malformed', 'succeeded'];
            const visibleStates = [];
            for (const suffix of stateIds) {
              previewButton.click();
              await Promise.resolve();
              await Promise.resolve();
              confirmButton.click();
              confirmButton.click();
              await Promise.resolve();
              await Promise.resolve();
              visibleStates.push(!document.getElementById(
                'memory-record-' + mode + '-' + suffix,
              ).hidden);
            }
            return {
              calls,
              visibleStates,
              previewDisabled: previewButton.disabled,
              confirmDisabled: confirmButton.disabled,
              leakedHandle: parent.textContent.includes(previewHandle),
            };
          }
          return JSON.stringify({ forget: await run('forget'), restore: await run('restore') });
        })()`);
        const parsed = JSON.parse(String(result)) as Record<string, {
          calls: Array<{
            handle: string;
            scope: string;
            body: Record<string, unknown>;
            confirm: boolean;
          }>;
          visibleStates: boolean[];
          previewDisabled: boolean;
          confirmDisabled: boolean;
          leakedHandle: boolean;
        }>;
        for (const [mode, transition] of Object.entries(parsed)) {
          expect(transition).toMatchObject({
            visibleStates: [true, true, true, true, true],
            previewDisabled: false,
            confirmDisabled: true,
            leakedHandle: false,
          });
          expect(transition.calls).toHaveLength(10);
          const forget = mode === 'forget';
          for (let index = 0; index < transition.calls.length; index += 2) {
            expect(transition.calls[index]).toEqual({
              handle: (forget ? 'R' : 'S').repeat(43),
              scope: (forget ? 'T' : 'U').repeat(43),
              body: { action: mode },
            });
            expect(transition.calls[index + 1]).toEqual({
              handle: (forget ? 'R' : 'S').repeat(43),
              scope: (forget ? 'T' : 'U').repeat(43),
              body: forget
                ? { confirm: true, previewHandle: 'P'.repeat(43) }
                : { confirm: true, previewHandle: 'Q'.repeat(43), action: 'restore' },
              confirm: true,
            });
          }
        }
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it('serves bounded rollback and expiration transition authority', async () => {
    const harness = await startHarness();
    const [script, memory, transitions] = await Promise.all([
      send(harness, '/governance/app.js'),
      send(harness, '/governance/memory.js'),
      send(harness, '/governance/memory-maintenance-transitions.js'),
    ]);

    expect(memory.body).toContain(
      "from '/governance/memory-maintenance-transitions.js';",
    );
    for (const definition of [
      'createMemoryMaintenanceTransitionWorkflow',
      'MEMORY_ROLLBACK_WORKFLOW',
      'MEMORY_EXPIRATION_WORKFLOW',
      "requestAction: 'rollback'",
      "requestAction: 'expire'",
      "currentState: 'applied'",
      "currentState: 'pending_review'",
      "value.rollback.boundary !== 'rollback_is_terminal'",
      "value.rollback.boundary !== 'expiration_does_not_apply_memory_effects'",
      "id: 'memory-review-' + config.key + '-confirmation-button'",
      'previewHandle: current.previewHandle',
      'if (expiryTimer !== null) window.clearTimeout(expiryTimer);',
    ]) expect(transitions.body).toContain(definition);
    expect(memory.body).toContain('rollbackWorkflow?.clear(preserveConfirmationResult);');
    expect(memory.body).toContain('expirationWorkflow?.clear(preserveConfirmationResult);');
    expect(script.body).not.toContain('previewHandle');
    for (const asset of [script, memory, transitions]) {
      expect(asset.status).toBe(200);
      expect(Buffer.byteLength(asset.body, 'utf8')).toBeLessThan(65_536);
      expect(asset.body).not.toContain('localStorage');
      expect(asset.body).not.toContain('sessionStorage');
      expect(asset.body).not.toContain('document.cookie');
      expect(asset.body).not.toContain('innerHTML');
      expect(asset.body).not.toContain('outerHTML');
      expect(asset.body).not.toContain('console.');
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes strict application preview projection in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(client, sessionId, 'new Promise((resolve) => setTimeout(resolve, 250))');
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const module = await import('/governance/memory-presentation.js');
          const now = Date.now();
          const timestamp = new Date(now - 1000).toISOString();
          const retainedMemoryRef = 'd'.repeat(16);
          const alternateMemoryRef = 'e'.repeat(16);
          const selectedReview = {
            proposalRef: 'b'.repeat(16), kind: 'conflict', effectType: 'resolve_conflict',
            lifecycleState: 'approved', scopeKind: 'system', candidateFingerprint: 'c'.repeat(64),
            confidence: 0.5, candidateCount: 2, reasonCodes: ['same_boundary_title_different_content'], revisionCount: 2,
            currentRevisionNumber: 2, createdAt: timestamp, updatedAt: timestamp,
            handle: 'R'.repeat(43), handleExpiresAt: now + 600000,
            scopeFingerprint: 'a'.repeat(16), scopeExpiresAt: now + 600000,
          };
          const detail = {
            proposalRef: selectedReview.proposalRef, kind: 'conflict', effectType: 'resolve_conflict',
            lifecycleState: 'approved', scopeKind: 'system', candidateFingerprint: selectedReview.candidateFingerprint,
            confidence: 0.5, candidateCount: 2, reasonCodes: ['same_boundary_title_different_content'], revisionCount: 2,
            currentRevisionNumber: 2, createdAt: timestamp, updatedAt: timestamp,
            effectMemoryRole: null,
            candidates: [retainedMemoryRef, alternateMemoryRef].map((memoryRef, candidateOrdinal) => ({
              candidateOrdinal, memoryRef, effectRole: 'conflict_candidate', expectedState: 'active',
              recordFingerprint: String(candidateOrdinal + 1).repeat(64), sourceCount: 1,
              sourceFingerprint: String(candidateOrdinal + 3).repeat(64),
            })),
            candidatesTruncated: false,
            revisions: [
              { revisionNumber: 1, transition: 'propose', previousState: null,
                newState: 'pending_review', actorClass: 'admin', invocationContext: 'admin_cli',
                reasonCode: 'same_boundary_title_different_content', createdAt: timestamp },
              { revisionNumber: 2, transition: 'approve', previousState: 'pending_review',
                newState: 'approved', actorClass: 'admin', invocationContext: 'admin_cli',
                reasonCode: 'approved', createdAt: timestamp },
            ],
            revisionsTruncated: false,
          };
          const preview = {
            action: 'memory.maintenance.apply',
            scope: { scopeKind: 'system', fingerprint: selectedReview.scopeFingerprint },
            proposalKind: 'conflict', proposalRef: selectedReview.proposalRef,
            proposedEffect: 'resolve_conflict',
            affectedRecords: { count: 2, fingerprint: selectedReview.candidateFingerprint, roles: [
              { role: 'retained', count: 1, fingerprint: '4'.repeat(64) },
              { role: 'superseded', count: 1, fingerprint: '5'.repeat(64) },
            ] },
            selection: { required: true, retainedMemoryRef },
            current: { lifecycleState: 'approved', revisionNumber: 2 },
            expected: { lifecycleState: 'applied', revisionNumber: 3,
              durableEffects: ['proposal_state_transition', 'proposal_revision_append',
                'audit_event_append', 'memory_record_revision_append', 'proposal_effect_evidence_append'],
              retrievalConsequences: ['superseded_records_excluded'] },
            rollback: { supported: true, boundary: 'separate_confirmation_required' },
            previewHandle: 'P'.repeat(43), previewExpiresAt: now + 300000,
            previewDigest: '6'.repeat(64),
          };
          const host = document.createElement('div');
          const evidence = module.detailTable(host, 'Application', ['Action', 'Effect', 'Transition', 'Rollback']);
          const populated = module.renderMemoryApplicationPreview(
            preview, selectedReview, detail, retainedMemoryRef, { evidence }, now,
          );
          const mismatch = module.normalizeMemoryApplicationPreview(
            preview, selectedReview, detail, alternateMemoryRef, now,
          );
          const detailHost = document.createElement('div');
          const detailState = module.renderMemoryReviewDetail(detail, selectedReview, {
            summary: module.detailTable(detailHost, 'Summary', ['a', 'b', 'c', 'd', 'e']),
            candidates: module.detailTable(detailHost, 'Candidates', ['a', 'b', 'c', 'd']),
            revisions: module.detailTable(detailHost, 'Revisions', ['a', 'b', 'c', 'd']),
            candidateCount: document.createElement('p'), revisionCount: document.createElement('p'),
          });
          return JSON.stringify({ populated: populated.state, mismatch: mismatch.state, detailState,
            leakedHandle: host.textContent.includes(preview.previewHandle), rendered: host.textContent });
        })()`);
        expect(JSON.parse(String(result))).toMatchObject({
          populated: 'populated',
          mismatch: 'malformed',
          detailState: 'content',
          leakedHandle: false,
        });
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes application preview and confirmation controller in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(
          client,
          sessionId,
          'new Promise((resolve) => setTimeout(resolve, 250))',
        );
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const module = await import('/governance/memory.js');
          const host = document.createElement('main');
          const navigation = document.createElement('nav');
          const activityNav = document.createElement('button');
          const activityView = document.createElement('section');
          navigation.append(activityNav);
          host.append(activityView);
          document.body.replaceChildren(navigation, host);
          const calls = [];
          const now = Date.now();
          const scopeHandle = 'S'.repeat(43);
          const reviewHandle = 'R'.repeat(43);
          const previewHandle = 'P'.repeat(43);
          const scopeFingerprint = 'a'.repeat(16);
          const proposalRef = 'b'.repeat(16);
          const candidateFingerprint = 'c'.repeat(64);
          const retainedMemoryRef = 'd'.repeat(16);
          const alternateMemoryRef = 'e'.repeat(16);
          const timestamp = new Date(now - 1000).toISOString();
          const expiresAt = now + 600000;
          const summary = {
            proposalRef,
            kind: 'conflict',
            effectType: 'resolve_conflict',
            lifecycleState: 'approved',
            scopeKind: 'system',
            candidateFingerprint,
            confidence: 0.5,
            candidateCount: 2,
            reasonCodes: ['same_boundary_title_different_content'],
            revisionCount: 2,
            currentRevisionNumber: 2,
            createdAt: timestamp,
            updatedAt: timestamp,
            handle: reviewHandle,
            handleExpiresAt: expiresAt,
          };
          const { handle: ignoredHandle, handleExpiresAt: ignoredExpiry, ...detailSummary } = summary;
          void ignoredHandle;
          void ignoredExpiry;
          const detail = {
            ...detailSummary,
            effectMemoryRole: null,
            candidates: [retainedMemoryRef, alternateMemoryRef].map((memoryRef, candidateOrdinal) => ({
              candidateOrdinal,
              memoryRef,
              effectRole: 'conflict_candidate',
              expectedState: 'active',
              recordFingerprint: String(candidateOrdinal + 1).repeat(64),
              sourceCount: 1,
              sourceFingerprint: String(candidateOrdinal + 3).repeat(64),
            })),
            candidatesTruncated: false,
            revisions: [
              { revisionNumber: 1, transition: 'propose', previousState: null,
                newState: 'pending_review', actorClass: 'admin', invocationContext: 'admin_cli',
                reasonCode: 'same_boundary_title_different_content', createdAt: timestamp },
              { revisionNumber: 2, transition: 'approve', previousState: 'pending_review',
                newState: 'approved', actorClass: 'admin', invocationContext: 'admin_cli',
                reasonCode: 'approved', createdAt: timestamp },
            ],
            revisionsTruncated: false,
          };
          const affectedRecords = { count: 2, fingerprint: candidateFingerprint, roles: [
            { role: 'retained', count: 1, fingerprint: '4'.repeat(64) },
            { role: 'superseded', count: 1, fingerprint: '5'.repeat(64) },
          ] };
          const preview = {
            action: 'memory.maintenance.apply',
            scope: { scopeKind: 'system', fingerprint: scopeFingerprint },
            proposalKind: 'conflict',
            proposalRef,
            proposedEffect: 'resolve_conflict',
            affectedRecords,
            selection: { required: true, retainedMemoryRef },
            current: { lifecycleState: 'approved', revisionNumber: 2 },
            expected: {
              lifecycleState: 'applied',
              revisionNumber: 3,
              durableEffects: ['proposal_state_transition', 'proposal_revision_append',
                'audit_event_append', 'memory_record_revision_append',
                'proposal_effect_evidence_append'],
              retrievalConsequences: ['superseded_records_excluded'],
            },
            rollback: { supported: true, boundary: 'separate_confirmation_required' },
            previewHandle,
            previewExpiresAt: now + 300000,
            previewDigest: '6'.repeat(64),
          };
          const confirmation = {
            action: 'memory.maintenance.apply',
            outcome: 'applied',
            proposalKind: 'conflict',
            proposalRef,
            proposedEffect: 'resolve_conflict',
            affectedRecords,
            selection: { required: true, retainedMemoryRef },
            current: { lifecycleState: 'applied', revisionNumber: 3 },
            retrievalConsequences: ['superseded_records_excluded'],
            evidence: { transition: 'apply', revisionRef: '7'.repeat(16), auditRef: '8'.repeat(16) },
            rollback: { supported: true, boundary: 'separate_confirmation_required' },
          };
          const confirmationResponses = [
            { status: 503, body: {} },
            { status: 404, body: {} },
            { status: 409, body: {} },
            { status: 200, body: { ...confirmation, unexpected: true } },
            { status: 200, body: confirmation },
          ];
          let confirmationIndex = 0;
          const requestJson = async () => ({ status: 200, body: detail });
          const requestMemoryMutation = async (path, scope, body) => {
            calls.push({ path, scope, body });
            return body.confirm
              ? confirmationResponses[confirmationIndex++]
              : { status: 201, body: preview };
          };
          const feature = module.createMemoryFeature(
            { navigation, activityNav, main: host, activityView },
            (element, hidden) => { element.hidden = hidden; },
            (element, text) => { element.textContent = text; },
            requestJson,
            requestMemoryMutation,
            () => {},
            () => {},
          );
          feature.selectSubview('reviews');
          feature.renderReviewCatalog({ entries: [{
            fingerprint: scopeFingerprint,
            scopeKind: 'system',
            label: 'System memory',
            handle: scopeHandle,
            expiresAt,
          }], truncated: false });
          feature.reviewScopeSelect.value = '1';
          feature.selectReviewScope();
          feature.renderReviews({ entries: [summary], truncated: false }, 'system');
          feature.selectReview(feature.reviewsList.querySelector('[data-review-index]'));
          await Promise.resolve();
          const detailState = feature.renderReviewDetail(detail, summary);
          const retainedSelect = document.getElementById('memory-review-retained-memory-select');
          retainedSelect.value = retainedMemoryRef;
          retainedSelect.dispatchEvent(new Event('change'));
          const previewButton = document.getElementById('memory-review-application-preview-button');
          const confirmButton = document.getElementById('memory-review-application-confirmation-button');
          const stateIds = [
            'memory-review-application-confirmation-unavailable',
            'memory-review-application-confirmation-not-found',
            'memory-review-application-confirmation-conflict',
            'memory-review-application-confirmation-malformed',
            'memory-review-application-confirmation-succeeded',
          ];
          const visibleStates = [];
          for (const stateId of stateIds) {
            previewButton.click();
            await Promise.resolve();
            await Promise.resolve();
            confirmButton.click();
            confirmButton.click();
            await Promise.resolve();
            await Promise.resolve();
            visibleStates.push(!document.getElementById(stateId).hidden);
          }
          return JSON.stringify({
            calls,
            detailState,
            visibleStates,
            selectedReview: feature.selectedReview(),
            confirmDisabled: confirmButton.disabled,
            successVisible: !document.getElementById(
              'memory-review-application-confirmation-succeeded',
            ).hidden,
            leakedHandle: document.body.textContent.includes(previewHandle),
          });
        })()`);
        const parsedResult = JSON.parse(String(result)) as {
          calls: Array<{
            path: string;
            scope: string;
            body: {
              confirm?: boolean;
              previewHandle?: string;
              action: string;
              retainedMemoryRef?: string;
            };
          }>;
          detailState: string;
          visibleStates: boolean[];
          selectedReview: unknown;
          confirmDisabled: boolean;
          successVisible: boolean;
          leakedHandle: boolean;
        };
        expect(parsedResult).toMatchObject({
          detailState: 'content',
          visibleStates: [true, true, true, true, true],
          selectedReview: null,
          confirmDisabled: true,
          successVisible: true,
          leakedHandle: false,
        });
        expect(parsedResult.calls).toHaveLength(10);
        for (let index = 0; index < parsedResult.calls.length; index += 2) {
          expect(parsedResult.calls[index]).toEqual({
            path: `/governance/api/v1/memory-reviews/${'R'.repeat(43)}`,
            scope: 'S'.repeat(43),
            body: { action: 'apply', retainedMemoryRef: 'd'.repeat(16) },
          });
          expect(parsedResult.calls[index + 1]).toEqual({
            path: `/governance/api/v1/memory-reviews/${'R'.repeat(43)}/confirm`,
            scope: 'S'.repeat(43),
            body: {
              confirm: true,
              previewHandle: 'P'.repeat(43),
              action: 'apply',
              retainedMemoryRef: 'd'.repeat(16),
            },
          });
        }
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes rollback and expiration preview-confirmation controllers in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(
          client,
          sessionId,
          'new Promise((resolve) => setTimeout(resolve, 250))',
        );
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const module = await import('/governance/memory.js');
          async function runTransition(mode) {
            const host = document.createElement('main');
            const navigation = document.createElement('nav');
            const activityNav = document.createElement('button');
            const activityView = document.createElement('section');
            navigation.append(activityNav);
            host.append(activityView);
            document.body.replaceChildren(navigation, host);
            const calls = [];
            const now = Date.now();
            const rollback = mode === 'rollback';
            const scopeHandle = (rollback ? 'S' : 'T').repeat(43);
            const reviewHandle = (rollback ? 'R' : 'U').repeat(43);
            const previewHandle = (rollback ? 'P' : 'V').repeat(43);
            const scopeFingerprint = (rollback ? 'a' : '9').repeat(16);
            const proposalRef = (rollback ? 'b' : '8').repeat(16);
            const candidateFingerprint = (rollback ? 'c' : '7').repeat(64);
            const timestamp = new Date(now - 1000).toISOString();
            const expiresAt = now + 600000;
            const currentRevisionNumber = rollback ? 3 : 1;
            const lifecycleState = rollback ? 'applied' : 'pending_review';
            const summary = {
              proposalRef,
              kind: 'decay',
              effectType: 'disable',
              lifecycleState,
              scopeKind: 'system',
              candidateFingerprint,
              confidence: 0.5,
              candidateCount: 1,
              reasonCodes: ['stale'],
              revisionCount: currentRevisionNumber,
              currentRevisionNumber,
              createdAt: timestamp,
              updatedAt: timestamp,
              handle: reviewHandle,
              handleExpiresAt: expiresAt,
            };
            const { handle: ignoredHandle, handleExpiresAt: ignoredExpiry, ...detailSummary } = summary;
            void ignoredHandle;
            void ignoredExpiry;
            const revisions = [{
              revisionNumber: 1,
              transition: 'propose',
              previousState: null,
              newState: 'pending_review',
              actorClass: 'admin',
              invocationContext: 'admin_cli',
              reasonCode: 'stale',
              createdAt: timestamp,
            }];
            if (rollback) revisions.push(
              { revisionNumber: 2, transition: 'approve', previousState: 'pending_review',
                newState: 'approved', actorClass: 'admin', invocationContext: 'admin_cli',
                reasonCode: 'approved', createdAt: timestamp },
              { revisionNumber: 3, transition: 'apply', previousState: 'approved',
                newState: 'applied', actorClass: 'admin', invocationContext: 'admin_cli',
                reasonCode: 'applied', createdAt: timestamp },
            );
            const detail = {
              ...detailSummary,
              effectMemoryRole: 'disable_target',
              effectMemoryRef: 'd'.repeat(16),
              candidates: [{
                candidateOrdinal: 0,
                memoryRef: 'd'.repeat(16),
                effectRole: 'disable_target',
                expectedState: 'active',
                recordFingerprint: 'f'.repeat(64),
                sourceCount: 1,
                sourceFingerprint: '1'.repeat(64),
              }],
              candidatesTruncated: false,
              revisions,
              revisionsTruncated: false,
            };
            const affectedRecords = rollback
              ? { count: 1, fingerprint: candidateFingerprint, roles: [{
                  role: 'restored', count: 1, fingerprint: '2'.repeat(64),
                }] }
              : { count: 1, fingerprint: candidateFingerprint };
            const preview = rollback ? {
              action: 'memory.maintenance.rollback',
              scope: { scopeKind: 'system', fingerprint: scopeFingerprint },
              proposalKind: 'decay',
              proposalRef,
              proposedEffect: 'disable',
              affectedRecords,
              current: { lifecycleState: 'applied', revisionNumber: 3 },
              expected: {
                lifecycleState: 'rolled_back',
                revisionNumber: 4,
                durableEffects: ['proposal_state_transition', 'proposal_revision_append',
                  'audit_event_append', 'memory_record_revision_append',
                  'proposal_effect_evidence_append'],
                retrievalConsequences: ['restored_records_included'],
              },
              confirmation: { required: true, boundary: 'separate_confirmation_required' },
              previewHandle,
              previewExpiresAt: now + 300000,
              previewDigest: '3'.repeat(64),
            } : {
              action: 'memory.maintenance.review.expire',
              scope: { scopeKind: 'system', fingerprint: scopeFingerprint },
              proposalKind: 'decay',
              proposalRef,
              proposedEffect: 'disable',
              affectedRecords,
              current: { lifecycleState: 'pending_review', revisionNumber: 1 },
              expected: {
                lifecycleState: 'expired',
                revisionNumber: 2,
                durableEffects: ['proposal_state_transition', 'proposal_revision_append',
                  'audit_event_append'],
                unavailableEffects: ['memory_record_mutation'],
              },
              rollback: {
                supported: false,
                boundary: 'expiration_does_not_apply_memory_effects',
              },
              previewHandle,
              previewExpiresAt: now + 300000,
              previewDigest: '4'.repeat(64),
            };
            const confirmation = rollback ? {
              action: 'memory.maintenance.rollback',
              outcome: 'rolled_back',
              proposalKind: 'decay',
              proposalRef,
              proposedEffect: 'disable',
              affectedRecords,
              current: { lifecycleState: 'rolled_back', revisionNumber: 4 },
              retrievalConsequences: ['restored_records_included'],
              evidence: {
                transition: 'rollback',
                revisionRef: '5'.repeat(16),
                auditRef: '6'.repeat(16),
              },
              rollback: { supported: false, boundary: 'rollback_is_terminal' },
            } : {
              action: 'memory.maintenance.review.expire',
              outcome: 'expired',
              proposalRef,
              current: { lifecycleState: 'expired', revisionNumber: 2 },
              evidence: {
                transition: 'expire',
                revisionRef: '5'.repeat(16),
                auditRef: '6'.repeat(16),
              },
              memoryRecordMutation: false,
              rollback: {
                supported: false,
                boundary: 'expiration_does_not_apply_memory_effects',
              },
            };
            const confirmationResponses = [
              { status: 503, body: {} },
              { status: 404, body: {} },
              { status: 409, body: {} },
              { status: 200, body: { ...confirmation, unexpected: true } },
              { status: 200, body: confirmation },
            ];
            let confirmationIndex = 0;
            const feature = module.createMemoryFeature(
              { navigation, activityNav, main: host, activityView },
              (element, hidden) => { element.hidden = hidden; },
              (element, text) => { element.textContent = text; },
              async () => ({ status: 200, body: detail }),
              async (path, scope, body) => {
                calls.push({ path, scope, body });
                return body.confirm
                  ? confirmationResponses[confirmationIndex++]
                  : { status: 201, body: preview };
              },
              () => {},
              () => {},
            );
            feature.selectSubview('reviews');
            feature.renderReviewCatalog({ entries: [{
              fingerprint: scopeFingerprint,
              scopeKind: 'system',
              label: 'System memory',
              handle: scopeHandle,
              expiresAt,
            }], truncated: false });
            feature.reviewScopeSelect.value = '1';
            feature.selectReviewScope();
            feature.renderReviews({ entries: [summary], truncated: false }, 'system');
            feature.selectReview(feature.reviewsList.querySelector('[data-review-index]'));
            await Promise.resolve();
            const detailState = feature.renderReviewDetail(detail, summary);
            const key = rollback ? 'rollback' : 'expiration';
            const previewButton = document.getElementById(
              'memory-review-' + key + '-preview-button',
            );
            const confirmButton = document.getElementById(
              'memory-review-' + key + '-confirmation-button',
            );
            const stateIds = [
              'memory-review-' + key + '-confirmation-unavailable',
              'memory-review-' + key + '-confirmation-not-found',
              'memory-review-' + key + '-confirmation-conflict',
              'memory-review-' + key + '-confirmation-malformed',
              'memory-review-' + key + '-confirmation-succeeded',
            ];
            const previewDisabledBefore = previewButton.disabled;
            const visibleStates = [];
            for (const stateId of stateIds) {
              previewButton.click();
              await Promise.resolve();
              await Promise.resolve();
              confirmButton.click();
              confirmButton.click();
              await Promise.resolve();
              await Promise.resolve();
              visibleStates.push(!document.getElementById(stateId).hidden);
            }
            return {
              calls,
              detailState,
              previewDisabledBefore,
              visibleStates,
              selectedReview: feature.selectedReview(),
              confirmDisabled: confirmButton.disabled,
              successVisible: !document.getElementById(
                'memory-review-' + key + '-confirmation-succeeded',
              ).hidden,
              leakedHandle: document.body.textContent.includes(previewHandle),
            };
          }
          return JSON.stringify({
            rollback: await runTransition('rollback'),
            expiration: await runTransition('expiration'),
          });
        })()`);
        const parsed = JSON.parse(String(result)) as Record<string, {
          calls: Array<{ path: string; scope: string; body: Record<string, unknown> }>;
          detailState: string;
          previewDisabledBefore: boolean;
          visibleStates: boolean[];
          selectedReview: unknown;
          confirmDisabled: boolean;
          successVisible: boolean;
          leakedHandle: boolean;
        }>;
        for (const [key, transition] of Object.entries(parsed)) {
          expect(transition).toMatchObject({
            detailState: 'content',
            previewDisabledBefore: false,
            visibleStates: [true, true, true, true, true],
            selectedReview: null,
            confirmDisabled: true,
            successVisible: true,
            leakedHandle: false,
          });
          expect(transition.calls).toHaveLength(10);
          const action = key === 'rollback' ? 'rollback' : 'expire';
          const handle = (key === 'rollback' ? 'R' : 'U').repeat(43);
          const scope = (key === 'rollback' ? 'S' : 'T').repeat(43);
          const previewHandle = (key === 'rollback' ? 'P' : 'V').repeat(43);
          for (let index = 0; index < transition.calls.length; index += 2) {
            expect(transition.calls[index]).toEqual({
              path: `/governance/api/v1/memory-reviews/${handle}`,
              scope,
              body: { action },
            });
            expect(transition.calls[index + 1]).toEqual({
              path: `/governance/api/v1/memory-reviews/${handle}/confirm`,
              scope,
              body: { confirm: true, previewHandle, action },
            });
          }
        }
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes the rejection preview and confirmation controller in Chromium',
    async () => {
    const harness = await startHarness();
    const browser = spawn(CHROMIUM_PATH, [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const client = await connectCdp(browser);
    try {
      const target = await client.send('Target.createTarget', { url: 'about:blank' });
      const targetId = String(target.targetId);
      const attached = await client.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      const sessionId = String(attached.sessionId);
      await client.send('Runtime.enable', {}, sessionId);
      await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
      await evaluateInChromium(
        client,
        sessionId,
        'new Promise((resolve) => setTimeout(resolve, 250))',
      );
      const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
        const module = await import('/governance/memory.js');
        const host = document.createElement('main');
        const navigation = document.createElement('nav');
        const activityNav = document.createElement('button');
        const activityView = document.createElement('section');
        navigation.append(activityNav);
        host.append(activityView);
        document.body.replaceChildren(navigation, host);
        const calls = [];
        const now = Date.now();
        const scopeHandle = 'S'.repeat(43);
        const reviewHandle = 'R'.repeat(43);
        const previewHandle = 'P'.repeat(43);
        const scopeFingerprint = 'a'.repeat(16);
        const proposalRef = 'b'.repeat(16);
        const candidateFingerprint = 'c'.repeat(64);
        const timestamp = new Date(now - 1000).toISOString();
        const expiresAt = now + 600000;
        const summary = {
          proposalRef,
          kind: 'decay',
          effectType: 'disable',
          lifecycleState: 'pending_review',
          scopeKind: 'system',
          candidateFingerprint,
          confidence: 0.5,
          candidateCount: 1,
          reasonCodes: ['stale'],
          revisionCount: 1,
          currentRevisionNumber: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          handle: reviewHandle,
          handleExpiresAt: expiresAt,
        };
        const { handle: ignoredHandle, handleExpiresAt: ignoredHandleExpiry, ...detailSummary } = summary;
        void ignoredHandle;
        void ignoredHandleExpiry;
        const detail = {
          ...detailSummary,
          effectMemoryRole: 'disable_target',
          effectMemoryRef: 'd'.repeat(16),
          candidates: [{
            candidateOrdinal: 0,
            memoryRef: 'd'.repeat(16),
            effectRole: 'disable_target',
            expectedState: 'active',
            recordFingerprint: 'f'.repeat(64),
            sourceCount: 1,
            sourceFingerprint: '1'.repeat(64),
          }],
          candidatesTruncated: false,
          revisions: [{
            revisionNumber: 1,
            transition: 'propose',
            previousState: null,
            newState: 'pending_review',
            actorClass: 'admin',
            invocationContext: 'admin_cli',
            reasonCode: 'stale',
            createdAt: timestamp,
          }],
          revisionsTruncated: false,
        };
        const preview = {
          action: 'memory.maintenance.review.reject',
          scope: { scopeKind: 'system', fingerprint: scopeFingerprint },
          proposalKind: 'decay',
          proposalRef,
          proposedEffect: 'disable',
          affectedRecords: { count: 1, fingerprint: candidateFingerprint },
          current: { lifecycleState: 'pending_review', revisionNumber: 1 },
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
          previewHandle,
          previewExpiresAt: now + 300000,
          previewDigest: '2'.repeat(64),
        };
        const confirmation = {
          action: 'memory.maintenance.review.reject',
          outcome: 'rejected',
          proposalRef,
          current: { lifecycleState: 'rejected', revisionNumber: 2 },
          evidence: {
            transition: 'reject',
            revisionRef: '3'.repeat(16),
            auditRef: '4'.repeat(16),
          },
          memoryRecordMutation: false,
          rollback: {
            supported: false,
            boundary: 'rejection_does_not_apply_memory_effects',
          },
        };
        const confirmationResponses = [
          { status: 503, body: {} },
          { status: 404, body: {} },
          { status: 409, body: {} },
          { status: 200, body: { ...confirmation, unexpected: true } },
          { status: 200, body: confirmation },
        ];
        let confirmationIndex = 0;
        const requestJson = async () => ({ status: 200, body: detail });
        const requestMemoryMutation = async (path, scope, body) => {
          calls.push({ path, scope, body });
          return body.confirm
            ? confirmationResponses[confirmationIndex++]
            : { status: 201, body: preview };
        };
        const feature = module.createMemoryFeature(
          { navigation, activityNav, main: host, activityView },
          (element, hidden) => { element.hidden = hidden; },
          (element, text) => { element.textContent = text; },
          requestJson,
          requestMemoryMutation,
          () => {},
          () => {},
        );
        feature.selectSubview('reviews');
        feature.renderReviewCatalog({
          entries: [{
            fingerprint: scopeFingerprint,
            scopeKind: 'system',
            label: 'System memory',
            handle: scopeHandle,
            expiresAt,
          }],
          truncated: false,
        });
        feature.reviewScopeSelect.value = '1';
        feature.selectReviewScope();
        feature.renderReviews({ entries: [summary], truncated: false }, 'system');
        const detailButton = feature.reviewsList.querySelector('[data-review-index]');
        feature.selectReview(detailButton);
        await Promise.resolve();
        const detailState = feature.renderReviewDetail(detail, summary);
        const rejectionPreviewButton = document.getElementById(
          'memory-review-rejection-preview-button',
        );
        const previewDisabledBefore = rejectionPreviewButton.disabled;
        const confirmationStateIds = [
          'memory-review-rejection-confirm-unavailable',
          'memory-review-rejection-confirm-not-found',
          'memory-review-rejection-confirm-conflict',
          'memory-review-rejection-confirm-malformed',
          'memory-review-rejection-succeeded',
        ];
        const visibleConfirmationStates = [];
        const confirmButton = document.getElementById('memory-review-rejection-confirm-button');
        for (const stateId of confirmationStateIds) {
          rejectionPreviewButton.click();
          await Promise.resolve();
          await Promise.resolve();
          confirmButton.click();
          confirmButton.click();
          await Promise.resolve();
          await Promise.resolve();
          visibleConfirmationStates.push(!document.getElementById(stateId).hidden);
        }
        return JSON.stringify({
          calls,
          detailState,
          previewDisabledBefore,
          visibleConfirmationStates,
          selectedReview: feature.selectedReview(),
          confirmDisabled: confirmButton.disabled,
          successVisible: !document.getElementById('memory-review-rejection-succeeded').hidden,
          leakedHandle: document.body.textContent.includes(previewHandle),
        });
      })()`);
      const parsedResult = JSON.parse(String(result)) as {
        calls: Array<{
          path: string;
          scope: string;
          body: { confirm?: boolean; previewHandle?: string; action: string };
        }>;
        detailState: string;
        previewDisabledBefore: boolean;
        visibleConfirmationStates: boolean[];
        selectedReview: unknown;
        confirmDisabled: boolean;
        successVisible: boolean;
        leakedHandle: boolean;
      };
      expect(parsedResult).toMatchObject({
        detailState: 'content',
        previewDisabledBefore: false,
        visibleConfirmationStates: [true, true, true, true, true],
        selectedReview: null,
        confirmDisabled: true,
        successVisible: true,
        leakedHandle: false,
      });
      expect(parsedResult.calls).toHaveLength(10);
      for (let index = 0; index < parsedResult.calls.length; index += 2) {
        expect(parsedResult.calls[index]).toEqual({
          path: `/governance/api/v1/memory-reviews/${'R'.repeat(43)}`,
          scope: 'S'.repeat(43),
          body: { action: 'reject' },
        });
        expect(parsedResult.calls[index + 1]).toEqual({
          path: `/governance/api/v1/memory-reviews/${'R'.repeat(43)}/confirm`,
          scope: 'S'.repeat(43),
          body: {
            confirm: true,
            previewHandle: 'P'.repeat(43),
            action: 'reject',
          },
        });
      }
    } finally {
      client.close();
      browser.kill('SIGKILL');
    }
    },
  );
  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'executes unscoped Identity and Operations controllers in Chromium',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(client, sessionId, 'new Promise((resolve) => setTimeout(resolve, 250))');
        const result = await evaluateInChromium(client, sessionId, String.raw`(async () => {
          const module = await import('/governance/administration.js');
          const mount = () => {
            const navigation = document.createElement('nav');
            const activityNav = document.createElement('button');
            const main = document.createElement('main');
            const activityView = document.createElement('section');
            navigation.append(activityNav);main.append(activityView);
            document.body.replaceChildren(navigation, main);
            return { navigation, activityNav, main, activityView };
          };
          const flush = async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));
          };
          const setHidden = (element, hidden) => { element.hidden = hidden; };
          const now = Date.now();
          const timestamp = new Date(now - 1000).toISOString();
          const expiresAt = now + 600000;
          const digest = 'd'.repeat(64);

          const identityElements = mount();
          const resourceHandle = 'R'.repeat(43);
          const identityPreviewHandle = 'I'.repeat(43);
          const rawAccount = '123456789';
          const account = {
            fingerprint: 'a'.repeat(16), platform: 'qq', accountType: 'private',
            verifiedLevel: 'owner_verified', status: 'active',
            firstSeenAt: timestamp, lastSeenAt: timestamp,
          };
          const identityCalls = [];
          const identity = module.createIdentityFeature(
            identityElements,
            setHidden,
            async (path, body) => {
              identityCalls.push({ path, body });
              if (!path.endsWith('/confirm')) return { status: 201, body: {
                action: 'identity.platform_account.unlink', account,
                current: { snapshotFingerprint: digest },
                expected: {
                  status: 'disabled',
                  durableEffects: ['platform_account_status_disabled', 'audit_event_append'],
                  identityConsequences: ['future_identity_resolution_blocked'],
                  privacyConsequences: ['platform_account_mapping_retained'],
                },
                rollback: { supported: false, boundary: 'platform_account_relink_not_available' },
                previewDigest: digest, resourceHandle, resourceExpiresAt: expiresAt,
                previewHandle: identityPreviewHandle, previewExpiresAt: expiresAt,
              } };
              return { status: 200, body: {
                action: 'identity.platform_account.unlink', outcome: 'unlinked',
                account: { ...account, status: 'disabled' },
                affectedRows: { platformAccounts: 1 }, disabledAt: timestamp,
                durableEffects: ['platform_account_status_disabled', 'audit_event_append'],
                identityConsequences: ['future_identity_resolution_blocked'],
                privacyConsequences: ['platform_account_mapping_retained'],
                evidence: {
                  auditEvent: 'identity.platform_account.unlinked',
                  reasonCode: 'governance_http_platform_account_unlink_confirmed',
                },
                rollback: { supported: false, boundary: 'platform_account_relink_not_available' },
              } };
            },
            () => {},
            () => {},
          );
          identity.load();
          document.getElementById('identity-account-input').value = rawAccount;
          document.getElementById('identity-preview-button').click();
          document.getElementById('identity-preview-button').click();
          await flush();
          document.getElementById('identity-confirm-button').click();
          document.getElementById('identity-confirm-button').click();
          await flush();
          const identityText = document.body.textContent;
          const identityResult = {
            calls: identityCalls,
            success: !document.getElementById('identity-success').hidden,
            inputCleared: document.getElementById('identity-account-input').value === '',
            leaked: [rawAccount, resourceHandle, identityPreviewHandle, digest]
              .some((secret) => identityText.includes(secret)),
          };

          const operationsElements = mount();
          const backupRef = 'B'.repeat(43);
          const backupPreviewHandle = 'P'.repeat(43);
          const restorePreviewHandle = 'S'.repeat(43);
          const retentionPreviewHandle = 'T'.repeat(43);
          const handoffId = 'H'.repeat(43);
          const operationsCalls = [];
          const counts = Object.fromEntries([
            'rawEvents', 'eventIngressReceipts', 'eventProcessingAdmissions',
            'chatMessages', 'eventProcessingFailures', 'agentTurns', 'contextTraces',
            'actionDecisions', 'actionExecutions', 'memoryRecords', 'memorySources',
            'memoryRevisions', 'toolCalls', 'auditLog', 'jobs', 'jobAttempts',
            'workerHeartbeats',
          ].map((key) => [key, 0]));
          const operations = module.createOperationsFeature(
            operationsElements,
            setHidden,
            async (path) => {
              operationsCalls.push({ kind: 'read', path });
              return { status: 200, body: {
                generatedAt: timestamp, overall: 'ok',
                database: { open: true, readonly: false, integrity: 'ok', foreignKeys: 'clean' },
                schema: { ready: true, requiredTablesPresent: 17, requiredTablesTotal: 17, missingTableCount: 0 },
                counts,
                configuration: {
                  oneBot: { transport: 'ws', httpConfigured: false, wsConfigured: true, tokenConfigured: true, botIdConfigured: true },
                  server: { hostConfigured: true, portConfigured: true, healthPathConfigured: true, readinessPathConfigured: true, metricsPathConfigured: true, eventPathConfigured: true },
                  retentionDays: { rawEvents: 30, chatMessages: 30, auditLog: 90, disabledDeletedMemory: 30, eventProcessingFailures: 30 },
                },
                workflows: { backup: { available: true }, restore: { available: true, executionBoundary: 'stopped_service_only' } },
              } };
            },
            async (path, body) => {
              operationsCalls.push({ kind: 'mutation', path, body });
              const retentionPolicy = { rawEventsDays: 90, chatMessagesDays: 90, auditLogDays: 365, disabledDeletedMemoryDays: 90, eventProcessingFailuresDays: 90 };
              const retentionEffects = { rawEventsDeleted: 2, modelInvocationSourcesDeleted: 1, chatMessagesDeleted: 2, auditLogDeleted: 3, eventProcessingFailuresDeleted: 1, memoriesPurged: 2, actionMemoryLinksCleared: 0, memorySourcesDeleted: 2, memoryRevisionsDeleted: 1, memoryFtsRowsDeleted: 0 };
              if (path.endsWith('/retention/confirm')) return { status: 200, body: {
                action: 'apply_configured_retention', status: 'applied', contractVersion: 1,
                appliedAt: timestamp, configuredPolicy: retentionPolicy,
                memoryStates: ['rejected', 'disabled', 'deleted'], effects: retentionEffects,
                zeroMeansForever: true,
                irreversible: { hardDelete: true, rollbackAvailable: false, boundary: 'verified_backup_recommended' },
              } };
              if (path.endsWith('/retention')) return { status: 201, body: {
                action: 'apply_configured_retention', currentState: digest, contractVersion: 1,
                asOf: timestamp, configuredPolicy: retentionPolicy,
                memoryStates: ['rejected', 'disabled', 'deleted'], effects: retentionEffects,
                zeroMeansForever: true,
                irreversible: { hardDelete: true, rollbackAvailable: false, boundary: 'verified_backup_recommended' },
                previewDigest: digest, previewHandle: retentionPreviewHandle, previewExpiresAt: expiresAt,
              } };
              if (path.endsWith('/restore/confirm')) return { status: 200, body: {
                status: 'pending', handoffId, expiresAt: new Date(now + 300000).toISOString(),
                executionBoundary: 'stopped_service_only', effects: { restoreExecution: false },
              } };
              if (path.endsWith('/restore')) return { status: 201, body: {
                action: 'prepare_restore_handoff', currentState: 'verified_backup_available', contractVersion: 1,
                artifact: { integrity: 'verified', sizeBytes: 2048 },
                effects: { databaseMutation: false, artifactMutation: false, restoreExecution: false, serviceStopRequired: true },
                restore: { available: true, executionBoundary: 'stopped_service_only' },
                rollback: { available: false, reason: 'no_in_process_effect' },
                previewDigest: digest, previewHandle: restorePreviewHandle, previewExpiresAt: expiresAt,
              } };
              if (path.endsWith('/confirm')) return { status: 200, body: {
                status: 'completed', artifact: { integrity: 'verified', sizeBytes: 2048 },
                pages: { total: 2, remaining: 0, complete: true },
                restore: { available: true, executionBoundary: 'stopped_service_only' },
                backupRef,
              } };
              return { status: 201, body: {
                action: 'create_verified_backup', currentState: 'available', contractVersion: 1,
                effects: { databaseMutation: false, privateArtifactCreation: true, integrityVerification: true, destinationOverwrite: false },
                restore: { availableAfterCompletion: true, executionBoundary: 'stopped_service_only' },
                rollback: { available: false, reason: 'artifact_removal_not_exposed' },
                previewDigest: digest, previewHandle: backupPreviewHandle, previewExpiresAt: expiresAt,
              } };
            },
            () => {},
            () => {},
          );
          await operations.load();
          document.getElementById('operations-backup-preview-button').click();
          document.getElementById('operations-backup-preview-button').click();await flush();
          document.getElementById('operations-confirm-button').click();
          document.getElementById('operations-confirm-button').click();await flush();
          document.getElementById('operations-restore-preview-button').click();
          document.getElementById('operations-restore-preview-button').click();await flush();
          document.getElementById('operations-confirm-button').click();
          document.getElementById('operations-confirm-button').click();await flush();
          document.getElementById('operations-retention-preview-button').click();
          document.getElementById('operations-retention-preview-button').click();await flush();
          document.getElementById('operations-retention-confirm-button').click();
          document.getElementById('operations-retention-confirm-button').click();await flush();
          const operationsText = document.body.textContent;
          return JSON.stringify({
            identityResult,
            operationsResult: {
              calls: operationsCalls.filter((call) => call.kind === 'mutation'),
              success: !document.getElementById('operations-success').hidden,
              restoreDisabled: document.getElementById('operations-restore-preview-button').disabled,
              text: operationsText,
              leaked: [backupRef, backupPreviewHandle, restorePreviewHandle, retentionPreviewHandle, handoffId, digest]
                .some((secret) => operationsText.includes(secret)),
            },
          });
        })()`);
        expect(JSON.parse(String(result))).toEqual({
          identityResult: {
            calls: [
              { path: '/governance/api/v1/identity/platform-accounts/unlink', body: { action: 'unlink', platform: 'qq', platformAccountId: '123456789' } },
              { path: '/governance/api/v1/identity/platform-accounts/unlink/confirm', body: { confirm: true, resourceHandle: 'R'.repeat(43), previewHandle: 'I'.repeat(43) } },
            ],
            success: true,
            inputCleared: true,
            leaked: false,
          },
          operationsResult: {
            calls: [
              { kind: 'mutation', path: '/governance/api/v1/operations', body: { action: 'create_verified_backup' } },
              { kind: 'mutation', path: '/governance/api/v1/operations/confirm', body: { confirm: true, previewHandle: 'P'.repeat(43) } },
              { kind: 'mutation', path: '/governance/api/v1/operations/restore', body: { action: 'prepare_restore_handoff', backupRef: 'B'.repeat(43) } },
              { kind: 'mutation', path: '/governance/api/v1/operations/restore/confirm', body: { confirm: true, previewHandle: 'S'.repeat(43), backupRef: 'B'.repeat(43) } },
              { kind: 'mutation', path: '/governance/api/v1/operations/retention', body: { action: 'apply_configured_retention' } },
              { kind: 'mutation', path: '/governance/api/v1/operations/retention/confirm', body: { confirm: true, previewHandle: 'T'.repeat(43) } },
            ],
            success: true,
            restoreDisabled: true,
            text: expect.stringContaining('No in-process restore'),
            leaked: false,
          },
        });
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it.skipIf(!existsSync(CHROMIUM_PATH))(
    'keeps every governance view accessible and bounded at desktop and mobile widths',
    async () => {
      const harness = await startHarness();
      const browser = spawn(CHROMIUM_PATH, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const client = await connectCdp(browser);
      try {
        const target = await client.send('Target.createTarget', { url: 'about:blank' });
        const attached = await client.send('Target.attachToTarget', {
          targetId: String(target.targetId),
          flatten: true,
        });
        const sessionId = String(attached.sessionId);
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Page.enable', {}, sessionId);
        await client.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `window.__governanceErrors = [];
            addEventListener('error', (event) => window.__governanceErrors.push(String(event.message)));
            addEventListener('unhandledrejection', (event) => window.__governanceErrors.push(String(event.reason)));`,
        }, sessionId);
        await client.send('Page.navigate', { url: `${harness.origin}/governance/` }, sessionId);
        await evaluateInChromium(client, sessionId, 'new Promise((resolve) => setTimeout(resolve, 500))');

        const inspect = async (width: number, height: number) => {
          await client.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: width < 600,
          }, sessionId);
          return JSON.parse(String(await evaluateInChromium(client, sessionId, String.raw`(() => {
            const topLevelViews = Array.from(document.querySelectorAll(
              '#overview-view, #activity-view, .memory-view',
            ));
            const viewOverflow = [];
            const navigation = document.getElementById('primary-navigation');
            const login = document.getElementById('login-view');
            navigation.hidden = false;login.hidden = true;
            for (const view of topLevelViews) {
              for (const candidate of topLevelViews) candidate.hidden = candidate !== view;
              const bodyOverflow = document.documentElement.scrollWidth > window.innerWidth;
              const viewOverflowing = view.scrollWidth > view.clientWidth + 1;
              if (bodyOverflow || viewOverflowing) viewOverflow.push(view.id);
            }
            for (const view of topLevelViews) view.hidden = true;
            const undersized = Array.from(document.querySelectorAll('button, input, select'))
              .filter((element) => Number.parseFloat(getComputedStyle(element).minHeight) < 44)
              .map((element) => element.id || element.textContent.trim()).slice(0, 10);
            const brokenControls = Array.from(document.querySelectorAll('[aria-controls]'))
              .filter((element) => !document.getElementById(element.getAttribute('aria-controls')))
              .map((element) => element.id);
            const brokenLabels = Array.from(document.querySelectorAll('[aria-labelledby]'))
              .filter((element) => element.getAttribute('aria-labelledby').split(/\s+/u)
                .some((id) => !document.getElementById(id)))
              .map((element) => element.id);
            const external = performance.getEntriesByType('resource')
              .map((entry) => new URL(entry.name))
              .filter((url) => url.origin !== location.origin)
              .map((url) => url.href);
            return JSON.stringify({
              width: window.innerWidth,
              viewCount: topLevelViews.length,
              viewOverflow,
              undersized,
              brokenControls,
              brokenLabels,
              external,
              errors: window.__governanceErrors || [],
              navigationScrollable: navigation.scrollWidth >= navigation.clientWidth,
            });
          })()`)));
        };

        const desktop = await inspect(1440, 1000);
        const mobile = await inspect(390, 844);
        const narrow = await inspect(375, 812);
        await client.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        }, sessionId);
        const reducedMotion = await evaluateInChromium(
          client,
          sessionId,
          "getComputedStyle(document.getElementById('login-button')).transitionDuration",
        );
        const contrast = JSON.parse(String(await evaluateInChromium(client, sessionId, String.raw`(() => {
          const root = getComputedStyle(document.documentElement);
          const rgb = (value) => {
            const hex = value.trim().replace('#', '');
            return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
              .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
          };
          const luminance = (value) => {
            const [red, green, blue] = rgb(value);
            return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          };
          const ratio = (foreground, background) => {
            const first = luminance(foreground);const second = luminance(background);
            return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
          };
          return JSON.stringify([
            ratio(root.getPropertyValue('--ink'), root.getPropertyValue('--surface')),
            ratio(root.getPropertyValue('--ink-muted'), root.getPropertyValue('--surface-raised')),
            ratio('#ffffff', root.getPropertyValue('--teal')),
            ratio(root.getPropertyValue('--red'), root.getPropertyValue('--red-soft')),
            ratio(root.getPropertyValue('--amber'), root.getPropertyValue('--amber-soft')),
            ratio(root.getPropertyValue('--green'), root.getPropertyValue('--green-soft')),
          ]);
        })()`)));
        await evaluateInChromium(client, sessionId, `(() => {
          document.getElementById('login-view').hidden = false;
          document.getElementById('primary-navigation').hidden = true;
          document.getElementById('admin-token').focus();
        })()`);
        await client.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
        }, sessionId);
        await client.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
        }, sessionId);
        const focused = await evaluateInChromium(client, sessionId, 'document.activeElement?.id');
        const screenshot = await client.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        }, sessionId);

        for (const result of [desktop, mobile, narrow]) {
          expect(result.viewCount).toBe(9);
          expect(result.viewOverflow).toEqual([]);
          expect(result.undersized).toEqual([]);
          expect(result.brokenControls).toEqual([]);
          expect(result.brokenLabels).toEqual([]);
          expect(result.external).toEqual([]);
          expect(result.errors).toEqual([]);
        }
        expect(desktop.width).toBe(1440);
        expect(mobile.width).toBe(390);
        expect(narrow.width).toBe(375);
        expect(mobile.navigationScrollable).toBe(true);
        expect(narrow.navigationScrollable).toBe(true);
        expect(reducedMotion).toBe('1e-05s');
        expect(contrast.every((ratio) => ratio >= 4.5)).toBe(true);
        expect(String(screenshot.data)).toMatch(/^iVBOR/u);
        expect(String(screenshot.data).length).toBeGreaterThan(1_000);
        expect(focused).toBe('login-button');
      } finally {
        client.close();
        browser.kill('SIGKILL');
      }
    },
  );

  it('rejects login origin, body, and credential failures without reflection or callbacks', async () => {
    const harness = await startHarness();
    const fixedForbidden = JSON.stringify({ error: 'forbidden' });
    const fixedBadRequest = JSON.stringify({ error: 'bad_request' });
    const fixedUnauthorized = JSON.stringify({ error: 'unauthorized' });

    const missingOrigin = await postJson(harness, `${API_PREFIX}/session`, {
      token: ADMIN_TOKEN,
    }, { origin: null });
    expect(missingOrigin).toMatchObject({ status: 403, body: fixedForbidden });

    const wrongOrigin = await postJson(harness, `${API_PREFIX}/session`, {
      token: ADMIN_TOKEN,
    }, { origin: 'http://127.0.0.1:1' });
    expect(wrongOrigin).toMatchObject({ status: 403, body: fixedForbidden });

    const malformed = await send(harness, `${API_PREFIX}/session`, {
      method: 'POST',
      headers: {
        Origin: harness.origin,
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    expect(malformed).toMatchObject({ status: 400, body: fixedBadRequest });

    for (const token of ['', 'wrong-governance-token', 'x'.repeat(513)]) {
      const response = await postJson(harness, `${API_PREFIX}/session`, { token });
      expect(response).toMatchObject({ status: 401, body: fixedUnauthorized });
      expect(response.body).not.toContain(token || ADMIN_TOKEN);
      expect(response.headers.get('set-cookie')).toBeNull();
      assertSecurityHeaders(response.headers);
    }

    const wrongShape = await postJson(harness, `${API_PREFIX}/session`, {
      token: ADMIN_TOKEN,
      actor: 'owner',
    });
    expect(wrongShape).toMatchObject({ status: 400, body: fixedBadRequest });

    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('creates a bounded independent session, rotates it, and never reflects secrets', async () => {
    const harness = await startHarness();
    const first = await login(harness);

    expect(first.status).toBe(201);
    expect(first.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
    expect(first.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body).not.toContain(ADMIN_TOKEN);
    expect(first.body).not.toContain(first.cookie.split('=')[1] ?? 'not-present');
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(first.headers.get('set-cookie')).toContain('Path=/governance');
    expect(first.headers.get('set-cookie')).toContain('Max-Age=900');
    expect(first.headers.get('set-cookie')).not.toContain('Domain=');
    expect(first.headers.get('set-cookie')).not.toContain('Secure');
    assertSecurityHeaders(first.headers);

    const session = await send(harness, `${API_PREFIX}/session`, {
      headers: { Cookie: first.cookie },
    });
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toEqual({
      actor: 'local_admin',
      expiresAt: harness.now.value + 900_000,
    });
    expect(session.body).not.toContain(first.cookie);
    expect(session.body).not.toContain(first.csrfToken);

    const rotated = await postJson(harness, `${API_PREFIX}/session`, {
      token: ADMIN_TOKEN,
    }, { cookie: first.cookie });
    expect(rotated.status).toBe(201);
    const rotatedCookie = extractCookie(rotated.headers);
    expect(rotatedCookie).not.toBe(first.cookie);
    expect((JSON.parse(rotated.body) as { csrfToken: string }).csrfToken).not.toBe(first.csrfToken);

    await expectSessionStatus(harness, first.cookie, 401);
    await expectSessionStatus(harness, rotatedCookie, 200);
  });

  it('rejects missing, malformed, unknown, duplicate, expired, logged-out, and restarted sessions', async () => {
    const harness = await startHarness();
    const loginResult = await login(harness);
    const unknownCookie = `${SESSION_COOKIE}=${'z'.repeat(43)}`;

    for (const cookie of [
      undefined,
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=not_base64url!`,
      unknownCookie,
      `${loginResult.cookie}; ${loginResult.cookie}`,
    ]) {
      await expectSessionStatus(harness, cookie, 401);
    }

    harness.now.value += 900_001;
    await expectSessionStatus(harness, loginResult.cookie, 401);

    harness.now.value = 1_800_000_000_000;
    const active = await login(harness);
    const logout = await send(harness, `${API_PREFIX}/session`, {
      method: 'DELETE',
      headers: {
        Cookie: active.cookie,
        Origin: harness.origin,
        'X-LetheBot-CSRF': active.csrfToken,
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    await expectSessionStatus(harness, active.cookie, 401);

    const beforeRestart = await login(harness);
    await harness.server.close();
    startedServers.splice(startedServers.indexOf(harness.server), 1);
    const restarted = await startHarness({ port: harness.port, now: harness.now });
    await expectSessionStatus(restarted, beforeRestart.cookie, 401);

    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('subordinates scope and resource handle state to the exact HTTP session lifecycle', async () => {
    const port = await reserveLoopbackPort();
    const now = { value: 1_800_000_000_000 };
    const scopeHandles = {
      resolve: vi.fn(() => ({ kind: 'global' } as const)),
      revokeSession: vi.fn(),
      clear: vi.fn(),
    };
    const resourceHandles = {
      resolve: vi.fn(() => ({ kind: RESOURCE_KIND, resourceId: 'synthetic-resource' })),
      revokeSession: vi.fn(),
      clear: vi.fn(),
    };
    const previewHandles = {
      revokeSession: vi.fn(),
      clear: vi.fn(),
    };
    const handleAuthorizedRequest = vi.fn(() => ({ status: 200, body: { ok: true } }));
    const serverOptions = {
      ...createOptions({
        enabled: true,
        port,
        now: () => now.value,
        scopeHandles,
        resourceHandles,
        handleAuthorizedRequest,
      }),
      previewHandles,
    };
    const server = new GovernanceHttpServer(serverOptions);
    await server.start();
    startedServers.push(server);
    const harness: Harness = {
      server,
      port,
      origin: `http://127.0.0.1:${port}`,
      now,
      resolveScopeHandle: scopeHandles.resolve,
      resolveResourceHandle: resourceHandles.resolve,
      handleAuthorizedRequest,
    };

    const first = await login(harness);
    const firstSessionId = digestSessionCookie(first.cookie);
    const scopedRead = await send(harness, READ_PATH, {
      headers: {
        Cookie: first.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    const rotated = await postJson(harness, `${API_PREFIX}/session`, {
      token: ADMIN_TOKEN,
    }, { cookie: first.cookie });
    const rotatedCookie = extractCookie(rotated.headers);
    const rotatedSessionId = digestSessionCookie(rotatedCookie);

    now.value += 900_001;
    await expectSessionStatus(harness, rotatedCookie, 401);

    const logoutSession = await login(harness);
    const logoutSessionId = digestSessionCookie(logoutSession.cookie);
    const logout = await send(harness, `${API_PREFIX}/session`, {
      method: 'DELETE',
      headers: {
        Cookie: logoutSession.cookie,
        Origin: harness.origin,
        'X-LetheBot-CSRF': logoutSession.csrfToken,
      },
    });

    const revokeCount = scopeHandles.revokeSession.mock.calls.length;
    const previewRevokeCount = previewHandles.revokeSession.mock.calls.length;
    await expectSessionStatus(
      harness,
      `${SESSION_COOKIE}=${'z'.repeat(43)}`,
      401,
    );
    await postJson(harness, `${API_PREFIX}/session`, { token: 'wrong-governance-token' });
    for (let index = 0; index < 8; index += 1) {
      await login(harness);
    }
    const atCapacity = await postJson(harness, `${API_PREFIX}/session`, {
      token: ADMIN_TOKEN,
    });
    await server.close();
    startedServers.splice(startedServers.indexOf(server), 1);

    expect({
      scopedReadStatus: scopedRead.status,
      logoutStatus: logout.status,
      capacityStatus: atCapacity.status,
      resolved: scopeHandles.resolve.mock.calls,
      revoked: scopeHandles.revokeSession.mock.calls,
      revokeCountAfterFailures: scopeHandles.revokeSession.mock.calls.length,
      revokeCountBeforeFailures: revokeCount,
      clearCount: scopeHandles.clear.mock.calls.length,
      resourceRevoked: resourceHandles.revokeSession.mock.calls,
      resourceClearCount: resourceHandles.clear.mock.calls.length,
      previewRevoked: previewHandles.revokeSession.mock.calls,
      previewRevokeCountAfterFailures: previewHandles.revokeSession.mock.calls.length,
      previewRevokeCountBeforeFailures: previewRevokeCount,
      previewClearCount: previewHandles.clear.mock.calls.length,
    }).toEqual({
      scopedReadStatus: 200,
      logoutStatus: 204,
      capacityStatus: 503,
      resolved: [[{
        sessionId: firstSessionId,
        handle: READ_HANDLE,
        purpose: 'memory.read',
      }]],
      revoked: [[firstSessionId], [rotatedSessionId], [logoutSessionId]],
      revokeCountAfterFailures: 3,
      revokeCountBeforeFailures: 3,
      clearCount: 1,
      resourceRevoked: [[firstSessionId], [rotatedSessionId], [logoutSessionId]],
      resourceClearCount: 1,
      previewRevoked: [[firstSessionId], [rotatedSessionId], [logoutSessionId]],
      previewRevokeCountAfterFailures: 3,
      previewRevokeCountBeforeFailures: 3,
      previewClearCount: 1,
    });
  });

  it('isolates authenticated-unscoped routes from every scope input and resolver', async () => {
    const port = await reserveLoopbackPort();
    const now = { value: 1_800_000_000_000 };
    const scopeHandles = {
      resolve: vi.fn(() => ({ kind: 'global' } as const)),
      revokeSession: vi.fn(),
      clear: vi.fn(),
    };
    const handleAuthenticatedUnscopedRequest = vi.fn(() => ({
      status: 200,
      body: { ok: true },
    }));
    const server = new GovernanceHttpServer(createOptions({
      enabled: true,
      port,
      now: () => now.value,
      scopeHandles,
      authenticatedUnscopedRoutes: [{
        method: 'GET',
        path: UNSCOPED_PATH,
        purpose: 'memory.maintenance.review.scopes',
        mutation: false,
      }],
      handleAuthenticatedUnscopedRequest,
    }));
    await server.start();
    startedServers.push(server);
    const harness: Harness = {
      server,
      port,
      origin: `http://127.0.0.1:${port}`,
      now,
      resolveScopeHandle: scopeHandles.resolve,
      resolveResourceHandle: vi.fn(),
      handleAuthorizedRequest: vi.fn(),
    };

    const unauthenticated = await send(harness, UNSCOPED_PATH);
    const session = await login(harness);
    const sessionId = digestSessionCookie(session.cookie);
    const withQuery = await send(harness, `${UNSCOPED_PATH}?scope=all`, {
      headers: { Cookie: session.cookie },
    });
    const withScope = await send(harness, UNSCOPED_PATH, {
      headers: {
        Cookie: session.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    const valid = await send(harness, UNSCOPED_PATH, {
      headers: { Cookie: session.cookie },
    });
    const sensitiveDiagnostic = 'synthetic-unscoped-handler-diagnostic';
    handleAuthenticatedUnscopedRequest.mockImplementationOnce(() => {
      throw new Error(sensitiveDiagnostic);
    });
    const handlerFailure = await send(harness, UNSCOPED_PATH, {
      headers: { Cookie: session.cookie },
    });
    handleAuthenticatedUnscopedRequest.mockImplementationOnce(() => ({
      status: 199,
      body: { ok: false },
    }));
    const malformedResult = await send(harness, UNSCOPED_PATH, {
      headers: { Cookie: session.cookie },
    });

    expect({
      statuses: [
        unauthenticated.status,
        withQuery.status,
        withScope.status,
        valid.status,
        handlerFailure.status,
        malformedResult.status,
      ],
      scopeResolveCount: scopeHandles.resolve.mock.calls.length,
      handlerCallCount: handleAuthenticatedUnscopedRequest.mock.calls.length,
      validHandlerCall: handleAuthenticatedUnscopedRequest.mock.calls[0],
      handlerFailureBody: handlerFailure.body,
    }).toEqual({
      statuses: [401, 400, 400, 200, 503, 503],
      scopeResolveCount: 0,
      handlerCallCount: 3,
      validHandlerCall: [{
        actor: { kind: 'local_admin' },
        route: {
          method: 'GET',
          path: UNSCOPED_PATH,
          purpose: 'memory.maintenance.review.scopes',
          mutation: false,
        },
        session: {
          sessionId,
          expiresAt: now.value + 900_000,
        },
        body: undefined,
      }],
      handlerFailureBody: JSON.stringify({ error: 'unavailable' }),
    });
    expect(handlerFailure.body).not.toContain(sensitiveDiagnostic);
  });

  it('requires session-bound CSRF before body or scope work on every mutation method', async () => {
    const harness = await startHarness();
    const first = await login(harness);
    const second = await login(harness);
    const mutationRoutes = [
      ['POST', WRITE_PATH],
      ['POST', `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`],
      ['PUT', REPLACE_PATH],
      ['PATCH', UPDATE_PATH],
      ['DELETE', REMOVE_PATH],
    ] as const;

    for (const [method, path] of mutationRoutes) {
      for (const headers of [
        { Cookie: first.cookie, Origin: harness.origin },
        {
          Cookie: first.cookie,
          Origin: 'http://127.0.0.1:1',
          'X-LetheBot-CSRF': first.csrfToken,
        },
        {
          Cookie: first.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': 'x'.repeat(43),
        },
        {
          Cookie: first.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': second.csrfToken,
        },
      ]) {
        const response = await send(harness, path, {
          method,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'X-LetheBot-Scope': WRITE_HANDLE,
          },
          body: '{',
        });
        expect(response).toMatchObject({
          status: 403,
          body: JSON.stringify({ error: 'forbidden' }),
        });
      }
    }

    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    const read = await send(harness, READ_PATH, {
      headers: {
        Cookie: first.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(read.status).toBe(200);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed and cross-boundary scopes before the authorized handler', async () => {
    const harness = await startHarness();
    const first = await login(harness);
    const second = await login(harness);

    for (const headers of [
      {},
      { 'X-LetheBot-Scope': '' },
      { 'X-LetheBot-Scope': '*' },
      { 'X-LetheBot-Scope': 'not-an-opaque-handle' },
      { 'X-LetheBot-Scope': `${READ_HANDLE}, ${WRITE_HANDLE}` },
    ]) {
      const response = await send(harness, READ_PATH, {
        headers: { Cookie: first.cookie, ...headers },
      });
      expect(response).toMatchObject({
        status: 400,
        body: JSON.stringify({ error: 'bad_request' }),
      });
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();

    for (const path of [
      `${READ_PATH}?scope=${READ_HANDLE}`,
      `${READ_PATH}?scopeKind=group`,
      `${READ_PATH}?groupId=synthetic-group`,
    ]) {
      const response = await send(harness, path, {
        headers: {
          Cookie: first.cookie,
          'X-LetheBot-Scope': READ_HANDLE,
        },
      });
      expect(response.status).toBe(400);
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();

    const unknown = await send(harness, READ_PATH, {
      headers: {
        Cookie: first.cookie,
        'X-LetheBot-Scope': UNKNOWN_HANDLE,
      },
    });
    expect(unknown).toMatchObject({
      status: 404,
      body: JSON.stringify({ error: 'not_found' }),
    });

    const mismatched = await send(harness, READ_PATH, {
      headers: {
        Cookie: first.cookie,
        'X-LetheBot-Scope': MISMATCHED_HANDLE,
      },
    });
    expect(mismatched.status).toBe(404);

    const valid = await send(harness, READ_PATH, {
      headers: {
        Cookie: first.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(valid.status).toBe(200);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(1);

    const crossSession = await send(harness, READ_PATH, {
      headers: {
        Cookie: second.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(crossSession.status).toBe(404);

    const crossPurpose = await send(harness, WRITE_PATH, {
      method: 'POST',
      headers: {
        Cookie: first.cookie,
        Origin: harness.origin,
        'X-LetheBot-CSRF': first.csrfToken,
        'X-LetheBot-Scope': READ_HANDLE,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(crossPurpose.status).toBe(404);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves one opaque dynamic resource only after the exact session and scope boundary', async () => {
    const harness = await startHarness();
    const unauthenticated = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
    );
    expect(unauthenticated.status).toBe(401);

    const first = await login(harness);
    const firstSessionId = digestSessionCookie(first.cookie);
    const missingResource = await send(harness, RESOURCE_READ_BASE_PATH, {
      headers: { Cookie: first.cookie, 'X-LetheBot-Scope': READ_HANDLE },
    });
    expect(missingResource.status).toBe(404);
    for (const path of [
      `${RESOURCE_READ_BASE_PATH}/synthetic-internal-resource`,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}/extra`,
    ]) {
      const malformed = await send(harness, path, {
        headers: { Cookie: first.cookie, 'X-LetheBot-Scope': READ_HANDLE },
      });
      expect(malformed.status).toBe(path.endsWith('/extra') ? 404 : 400);
    }
    const query = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}?proposal=raw-id`,
      { headers: { Cookie: first.cookie, 'X-LetheBot-Scope': READ_HANDLE } },
    );
    expect(query.status).toBe(400);
    const missingScope = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
      { headers: { Cookie: first.cookie } },
    );
    expect(missingScope.status).toBe(400);
    const previewWithoutCsrf = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
      {
        method: 'POST',
        headers: {
          Cookie: first.cookie,
          Origin: harness.origin,
          'X-LetheBot-Scope': READ_HANDLE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'approve' }),
      },
    );
    expect(previewWithoutCsrf.status).toBe(403);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    const unknown = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${UNKNOWN_RESOURCE_HANDLE}`,
      { headers: { Cookie: first.cookie, 'X-LetheBot-Scope': READ_HANDLE } },
    );
    expect(unknown).toMatchObject({
      status: 404,
      body: JSON.stringify({ error: 'not_found' }),
    });
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    const valid = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
      { headers: { Cookie: first.cookie, 'X-LetheBot-Scope': READ_HANDLE } },
    );
    expect(valid.status).toBe(200);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(1);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledWith({
      actor: { kind: 'local_admin' },
      route: {
        method: 'GET',
        path: RESOURCE_READ_ROUTE_PATH,
        purpose: 'memory.read',
        mutation: false,
        resourceKind: RESOURCE_KIND,
      },
      session: {
        sessionId: firstSessionId,
        expiresAt: harness.now.value + 900_000,
      },
      scope: { kind: 'global' },
      resource: { kind: RESOURCE_KIND, resourceId: 'synthetic-internal-resource' },
      body: undefined,
    });

    const previewBody = { action: 'approve' };
    const validPreview = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
      {
        method: 'POST',
        headers: {
          Cookie: first.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': first.csrfToken,
          'X-LetheBot-Scope': READ_HANDLE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(previewBody),
      },
    );
    expect(validPreview.status).toBe(200);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(2);
    expect(harness.handleAuthorizedRequest).toHaveBeenLastCalledWith({
      actor: { kind: 'local_admin' },
      route: {
        method: 'POST',
        path: RESOURCE_PREVIEW_ROUTE_PATH,
        purpose: 'memory.read',
        mutation: true,
        resourceKind: RESOURCE_KIND,
      },
      session: {
        sessionId: firstSessionId,
        expiresAt: harness.now.value + 900_000,
      },
      scope: { kind: 'global' },
      resource: { kind: RESOURCE_KIND, resourceId: 'synthetic-internal-resource' },
      body: previewBody,
    });

    const wrongScope = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
      { headers: { Cookie: first.cookie, 'X-LetheBot-Scope': OTHER_SCOPE_HANDLE } },
    );
    const wrongPurpose = await send(
      harness,
      `${RESOURCE_OTHER_PURPOSE_BASE_PATH}/${RESOURCE_HANDLE}`,
      { headers: { Cookie: first.cookie, 'X-LetheBot-Scope': OTHER_PURPOSE_SCOPE_HANDLE } },
    );
    const wrongKind = await send(
      harness,
      `${RESOURCE_OTHER_KIND_BASE_PATH}/${RESOURCE_HANDLE}`,
      { headers: { Cookie: first.cookie, 'X-LetheBot-Scope': READ_HANDLE } },
    );
    const second = await login(harness);
    const crossSession = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`,
      { headers: { Cookie: second.cookie, 'X-LetheBot-Scope': SECOND_READ_HANDLE } },
    );
    expect([
      wrongScope.status,
      wrongPurpose.status,
      wrongKind.status,
      crossSession.status,
    ]).toEqual([404, 404, 404, 404]);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(2);
    expect(harness.resolveResourceHandle).toHaveBeenCalledWith({
      sessionId: digestSessionCookie(second.cookie),
      handle: RESOURCE_HANDLE,
      purpose: 'memory.read',
      resourceKind: RESOURCE_KIND,
      scope: { kind: 'global' },
    });
  });

  it('matches one exact static suffix after an opaque resource handle', async () => {
    const confirmRoute: GovernanceHttpRoute = {
      method: 'POST',
      path: RESOURCE_CONFIRM_ROUTE_PATH,
      purpose: 'memory.read',
      mutation: true,
      resourceKind: RESOURCE_KIND,
    };
    const harness = await startHarness({
      authorizedRoutes: [...AUTHORIZED_ROUTES, confirmRoute],
    });
    const session = await login(harness);
    const confirmPath = `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}/confirm`;
    const confirmBody = { confirm: true, previewHandle: 'v'.repeat(43) };

    for (const path of [
      `${confirmPath}/extra`,
      `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}/confirmation`,
    ]) {
      const unmatched = await send(harness, path, {
        method: 'POST',
        headers: {
          Cookie: session.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': session.csrfToken,
          'X-LetheBot-Scope': READ_HANDLE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(confirmBody),
      });
      expect(unmatched.status).toBe(404);
    }
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    const malformedHandle = await send(
      harness,
      `${RESOURCE_READ_BASE_PATH}/synthetic-internal-resource/confirm`,
      {
        method: 'POST',
        headers: {
          Cookie: session.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': session.csrfToken,
          'X-LetheBot-Scope': READ_HANDLE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(confirmBody),
      },
    );
    expect(malformedHandle.status).toBe(400);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();

    const missingCsrf = await send(harness, confirmPath, {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        Origin: harness.origin,
        'X-LetheBot-Scope': READ_HANDLE,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(confirmBody),
    });
    expect(missingCsrf.status).toBe(403);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();

    const confirmed = await send(harness, confirmPath, {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        Origin: harness.origin,
        'X-LetheBot-CSRF': session.csrfToken,
        'X-LetheBot-Scope': READ_HANDLE,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(confirmBody),
    });
    expect(confirmed.status).toBe(200);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledTimes(1);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledWith({
      actor: { kind: 'local_admin' },
      route: confirmRoute,
      session: {
        sessionId: digestSessionCookie(session.cookie),
        expiresAt: harness.now.value + 900_000,
      },
      scope: { kind: 'global' },
      resource: { kind: RESOURCE_KIND, resourceId: 'synthetic-internal-resource' },
      body: confirmBody,
    });
  });

  it('ignores QQ role and forwarded identity headers and supplies a server-owned actor', async () => {
    const harness = await startHarness();
    const unauthenticated = await send(harness, READ_PATH, {
      headers: {
        'X-LetheBot-Scope': READ_HANDLE,
        'X-QQ-Role': 'owner',
        'X-LetheBot-Actor': 'local_admin',
        'X-Forwarded-For': '127.0.0.1',
        'X-Forwarded-Host': new URL(harness.origin).host,
      },
    });
    expect(unauthenticated.status).toBe(401);
    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    const loginResult = await login(harness);
    const authenticated = await send(harness, READ_PATH, {
      headers: {
        Cookie: loginResult.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
        'X-QQ-Role': 'member',
        'X-LetheBot-Actor': 'anonymous',
        'X-Forwarded-For': '203.0.113.20',
        'X-Forwarded-Host': 'external.example.invalid',
      },
    });
    expect(authenticated.status).toBe(200);
    expect(harness.handleAuthorizedRequest).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: 'local_admin' },
      scope: { kind: 'global' },
      route: expect.objectContaining({ purpose: 'memory.read' }),
    }));
    expect(authenticated.body).not.toContain('owner');
    expect(authenticated.body).not.toContain('member');
    expect(authenticated.body).not.toContain('203.0.113.20');
  });

  it('contains scope and authorized-handler failures behind one fixed unavailable response', async () => {
    const harness = await startHarness();
    const loginResult = await login(harness);
    const sensitiveDiagnostic = 'synthetic-private-diagnostic';

    harness.resolveScopeHandle.mockImplementationOnce(() => {
      throw new Error(sensitiveDiagnostic);
    });
    const scopeFailure = await send(harness, READ_PATH, {
      headers: {
        Cookie: loginResult.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(scopeFailure).toMatchObject({
      status: 503,
      body: JSON.stringify({ error: 'unavailable' }),
    });
    expect(scopeFailure.body).not.toContain(sensitiveDiagnostic);
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    harness.handleAuthorizedRequest.mockImplementationOnce(() => {
      throw new Error(sensitiveDiagnostic);
    });
    const handlerFailure = await send(harness, READ_PATH, {
      headers: {
        Cookie: loginResult.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(handlerFailure).toMatchObject({
      status: 503,
      body: JSON.stringify({ error: 'unavailable' }),
    });
    expect(handlerFailure.body).not.toContain(sensitiveDiagnostic);
    assertSecurityHeaders(handlerFailure.headers);
  });

  it('contains resource resolver failures and rejects malformed resolved resources', async () => {
    const harness = await startHarness();
    const loginResult = await login(harness);
    const sensitiveDiagnostic = 'synthetic-private-resource-diagnostic';
    const detailPath = `${RESOURCE_READ_BASE_PATH}/${RESOURCE_HANDLE}`;

    harness.resolveResourceHandle.mockImplementationOnce(() => {
      throw new Error(sensitiveDiagnostic);
    });
    const resolverFailure = await send(harness, detailPath, {
      headers: {
        Cookie: loginResult.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(resolverFailure).toMatchObject({
      status: 503,
      body: JSON.stringify({ error: 'unavailable' }),
    });
    expect(resolverFailure.body).not.toContain(sensitiveDiagnostic);
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();

    harness.resolveResourceHandle.mockImplementationOnce(() => ({
      kind: RESOURCE_KIND,
      resourceId: 'synthetic-internal-resource',
      leaked: sensitiveDiagnostic,
    }));
    const malformedResolution = await send(harness, detailPath, {
      headers: {
        Cookie: loginResult.cookie,
        'X-LetheBot-Scope': READ_HANDLE,
      },
    });
    expect(malformedResolution).toMatchObject({
      status: 404,
      body: JSON.stringify({ error: 'not_found' }),
    });
    expect(malformedResolution.body).not.toContain(sensitiveDiagnostic);
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('bounds declared and streamed bodies and terminates a slow body exactly once', async () => {
    const harness = await startHarness({ bodyTimeoutMs: 50 });
    const loginResult = await login(harness);
    const oversized = 'x'.repeat(4_097);

    const declared = await send(harness, WRITE_PATH, {
      method: 'POST',
      headers: {
        Cookie: loginResult.cookie,
        Origin: harness.origin,
        'X-LetheBot-CSRF': loginResult.csrfToken,
        'X-LetheBot-Scope': WRITE_HANDLE,
        'Content-Type': 'application/json',
      },
      body: oversized,
    });
    expect(declared).toMatchObject({
      status: 413,
      body: JSON.stringify({ error: 'body_too_large' }),
    });
    assertSecurityHeaders(declared.headers);

    const streamed = await sendStreamedOversizedBody(harness, loginResult);
    expect(streamed).toMatchObject({
      status: 413,
      body: JSON.stringify({ error: 'body_too_large' }),
    });
    assertSecurityHeaders(streamed.headers);

    const missingCsrfBeforeBody = await send(harness, WRITE_PATH, {
      method: 'POST',
      headers: {
        Cookie: loginResult.cookie,
        Origin: harness.origin,
        'X-LetheBot-Scope': WRITE_HANDLE,
        'Content-Type': 'application/json',
      },
      body: oversized,
    });
    expect(missingCsrfBeforeBody.status).toBe(403);

    const timedOut = await sendPartialBody(harness, loginResult);
    expect(timedOut).toMatchObject({
      status: 408,
      body: JSON.stringify({ error: 'request_timeout' }),
    });
    assertSecurityHeaders(timedOut.headers);

    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  it('enforces session capacity, prunes expiry, and keeps every failure callback-free', async () => {
    const harness = await startHarness();
    const sessions: LoginResult[] = [];
    for (let index = 0; index < 8; index += 1) {
      sessions.push(await login(harness));
    }

    const full = await postJson(harness, `${API_PREFIX}/session`, { token: ADMIN_TOKEN });
    expect(full).toMatchObject({
      status: 503,
      body: JSON.stringify({ error: 'unavailable' }),
    });
    expect(full.headers.get('set-cookie')).toBeNull();

    harness.now.value += 900_001;
    const afterExpiry = await login(harness);
    expect(afterExpiry.status).toBe(201);
    await expectSessionStatus(harness, sessions[0]?.cookie, 401);

    expect(harness.resolveScopeHandle).not.toHaveBeenCalled();
    expect(harness.handleAuthorizedRequest).not.toHaveBeenCalled();
  });

  async function startHarness(overrides: {
    readonly port?: number;
    readonly now?: { value: number };
    readonly bodyTimeoutMs?: number;
    readonly authorizedRoutes?: readonly GovernanceHttpRoute[];
  } = {}): Promise<Harness> {
    const port = overrides.port ?? await reserveLoopbackPort();
    const now = overrides.now ?? { value: 1_800_000_000_000 };
    const scopeOwners = new Map<string, string>();
    const resolveScopeHandle = vi.fn((input: {
      readonly sessionId: string;
      readonly handle: string;
      readonly purpose: string;
    }) => {
      if (input.handle === MISMATCHED_HANDLE) {
        return {
          kind: 'conversation',
          conversationId: 'synthetic-conversation',
          conversationType: 'group',
        };
      }
      const expectedPurpose = (
        input.handle === READ_HANDLE
        || input.handle === SECOND_READ_HANDLE
        || input.handle === OTHER_SCOPE_HANDLE
      )
        ? 'memory.read'
        : input.handle === OTHER_PURPOSE_SCOPE_HANDLE
          ? 'memory.other'
          : input.handle === WRITE_HANDLE
          ? 'memory.write'
          : undefined;
      if (!expectedPurpose || input.purpose !== expectedPurpose) {
        return null;
      }
      const owner = scopeOwners.get(input.handle);
      if (owner && owner !== input.sessionId) {
        return null;
      }
      scopeOwners.set(input.handle, input.sessionId);
      return input.handle === OTHER_SCOPE_HANDLE
        ? { kind: 'system' } as const
        : { kind: 'global' } as const;
    });
    const resourceOwners = new Map<string, string>();
    const resolveResourceHandle = vi.fn((input: {
      readonly sessionId: string;
      readonly handle: string;
      readonly purpose: string;
      readonly resourceKind: string;
      readonly scope: { readonly kind: string };
    }) => {
      if (
        input.handle !== RESOURCE_HANDLE
        || input.purpose !== 'memory.read'
        || input.resourceKind !== RESOURCE_KIND
        || input.scope.kind !== 'global'
      ) {
        return null;
      }
      const owner = resourceOwners.get(input.handle);
      if (owner && owner !== input.sessionId) {
        return null;
      }
      resourceOwners.set(input.handle, input.sessionId);
      return { kind: RESOURCE_KIND, resourceId: 'synthetic-internal-resource' };
    });
    const handleAuthorizedRequest = vi.fn((input: { readonly route: { readonly purpose: string } }) => ({
      status: 200,
      body: { ok: true, purpose: input.route.purpose },
    }));
    const scopeHandles = {
      resolve: resolveScopeHandle,
      revokeSession: vi.fn(),
      clear: vi.fn(),
    };
    const resourceHandles = {
      resolve: resolveResourceHandle,
      revokeSession: vi.fn(),
      clear: vi.fn(),
    };
    const server = new GovernanceHttpServer(createOptions({
      enabled: true,
      host: '127.0.0.1',
      port,
      now: () => now.value,
      ...(overrides.bodyTimeoutMs === undefined
        ? {}
        : { bodyTimeoutMs: overrides.bodyTimeoutMs }),
      ...(overrides.authorizedRoutes === undefined
        ? {}
        : { authorizedRoutes: overrides.authorizedRoutes }),
      scopeHandles,
      resourceHandles,
      handleAuthorizedRequest,
    }));
    await server.start();
    startedServers.push(server);
    return {
      server,
      port,
      origin: `http://127.0.0.1:${port}`,
      now,
      resolveScopeHandle,
      resolveResourceHandle,
      handleAuthorizedRequest,
    };
  }

  async function sendPartialBody(
    harness: Harness,
    loginResult: LoginResult,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const partialRequest = request({
        host: '127.0.0.1',
        port: harness.port,
        path: WRITE_PATH,
        method: 'POST',
        headers: {
          Cookie: loginResult.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': loginResult.csrfToken,
          'X-LetheBot-Scope': WRITE_HANDLE,
          'Content-Type': 'application/json',
          'Content-Length': 2,
          Connection: 'close',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: new Headers(response.headers as Record<string, string>),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      partialRequests.push(partialRequest);
      partialRequest.on('error', reject);
      partialRequest.flushHeaders();
      partialRequest.write('{');
    });
  }

  async function sendStreamedOversizedBody(
    harness: Harness,
    loginResult: LoginResult,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const streamedRequest = request({
        host: '127.0.0.1',
        port: harness.port,
        path: WRITE_PATH,
        method: 'POST',
        headers: {
          Cookie: loginResult.cookie,
          Origin: harness.origin,
          'X-LetheBot-CSRF': loginResult.csrfToken,
          'X-LetheBot-Scope': WRITE_HANDLE,
          'Content-Type': 'application/json',
          Connection: 'close',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: new Headers(response.headers as Record<string, string>),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      partialRequests.push(streamedRequest);
      streamedRequest.on('error', reject);
      streamedRequest.end(Buffer.alloc(4_097, 'x'));
    });
  }
});

function createOptions(
  overrides: Partial<GovernanceHttpServerOptions> = {},
): GovernanceHttpServerOptions {
  return {
    enabled: false,
    host: '127.0.0.1',
    port: 6701,
    adminToken: ADMIN_TOKEN,
    sessionTtlMs: 900_000,
    bodyLimitBytes: 4_096,
    bodyTimeoutMs: 5_000,
    now: () => Date.now(),
    authorizedRoutes: AUTHORIZED_ROUTES,
    authenticatedUnscopedRoutes: [],
    scopeHandles: {
      resolve: () => null,
      revokeSession: () => undefined,
      clear: () => undefined,
    },
    resourceHandles: {
      resolve: () => null,
      revokeSession: () => undefined,
      clear: () => undefined,
    },
    previewHandles: {
      revokeSession: () => undefined,
      clear: () => undefined,
    },
    handleAuthorizedRequest: () => ({ status: 200, body: { ok: true } }),
    handleAuthenticatedUnscopedRequest: () => ({ status: 200, body: { ok: true } }),
    ...overrides,
  };
}

async function login(harness: Harness): Promise<LoginResult> {
  const response = await postJson(harness, `${API_PREFIX}/session`, { token: ADMIN_TOKEN });
  const body = JSON.parse(response.body) as { csrfToken: string };
  return {
    ...response,
    cookie: extractCookie(response.headers),
    csrfToken: body.csrfToken,
  };
}

async function postJson(
  harness: Harness,
  path: string,
  body: unknown,
  options: { readonly origin?: string | null; readonly cookie?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.origin !== null) {
    headers.Origin = options.origin ?? harness.origin;
  }
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  return send(harness, path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function expectSessionStatus(
  harness: Harness,
  cookie: string | undefined,
  status: number,
): Promise<void> {
  const response = await send(harness, `${API_PREFIX}/session`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  expect(response.status).toBe(status);
  if (status === 401) {
    expect(response.body).toBe(JSON.stringify({ error: 'unauthorized' }));
    assertSecurityHeaders(response.headers);
  }
}

async function send(
  harness: Harness,
  path: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  headers.set('Connection', 'close');
  const response = await fetch(`${harness.origin}${path}`, { ...init, headers });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

function extractCookie(headers: Headers): string {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Expected governance session cookie');
  }
  return setCookie.split(';', 1)[0] ?? '';
}

function digestSessionCookie(cookie: string): string {
  const value = cookie.slice(`${SESSION_COOKIE}=`.length);
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSecurityHeaders(headers: Headers): void {
  expect(headers.get('cache-control')).toBe('no-store');
  expect(headers.get('referrer-policy')).toBe('no-referrer');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('content-security-policy')).toBe(
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
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
