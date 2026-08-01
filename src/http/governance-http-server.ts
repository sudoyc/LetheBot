import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  getGovernanceBrowserAsset,
  type GovernanceBrowserAsset,
} from './governance-browser-assets.js';

const API_PREFIX = '/governance/api/v1';
const SESSION_PATH = `${API_PREFIX}/session`;
const SESSION_COOKIE = 'lethebot_governance_session';
const CSRF_HEADER = 'x-lethebot-csrf';
const SCOPE_HEADER = 'x-lethebot-scope';
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSIONS = 8;
const RESOURCE_PATH_PARAMETER = '/:resourceHandle';
const RESOURCE_ROUTE_SUFFIX_PATTERN = /^(?:\/[a-z][a-z0-9_-]{0,127})?$/u;
const MAX_RESOURCE_KIND_LENGTH = 128;
const MAX_RESOURCE_IDENTIFIER_LENGTH = 256;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
} as const;

type GovernanceHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type GovernanceScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'user'; readonly canonicalUserId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | {
      readonly kind: 'conversation';
      readonly conversationId: string;
      readonly conversationType: 'private' | 'group';
      readonly groupId?: string;
    }
  | { readonly kind: 'tool'; readonly toolName: string }
  | { readonly kind: 'system' };

export interface GovernanceHttpRoute {
  readonly method: GovernanceHttpMethod;
  readonly path: string;
  readonly purpose: string;
  readonly mutation: boolean;
  readonly resourceKind?: string;
}

export interface GovernanceHttpScopeResolutionInput {
  readonly sessionId: string;
  readonly handle: string;
  readonly purpose: string;
}

export interface GovernanceHttpScopeHandleStore {
  resolve(input: GovernanceHttpScopeResolutionInput): unknown | Promise<unknown>;
  revokeSession(sessionId: string): void;
  clear(): void;
}

export interface GovernanceHttpResourceResolutionInput {
  readonly sessionId: string;
  readonly handle: string;
  readonly purpose: string;
  readonly resourceKind: string;
  readonly scope: GovernanceScope;
}

export interface GovernanceHttpResolvedResource {
  readonly kind: string;
  readonly resourceId: string;
}

export interface GovernanceHttpResourceHandleStore {
  resolve(input: GovernanceHttpResourceResolutionInput): unknown | Promise<unknown>;
  revokeSession(sessionId: string): void;
  clear(): void;
}

export interface GovernanceHttpPreviewHandleStore {
  revokeSession(sessionId: string): void;
  clear(): void;
}

export interface GovernanceHttpAuthorizedRequest {
  readonly actor: { readonly kind: 'local_admin' };
  readonly route: GovernanceHttpRoute;
  readonly session: {
    readonly sessionId: string;
    readonly expiresAt: number;
  };
  readonly scope: GovernanceScope;
  readonly resource?: GovernanceHttpResolvedResource;
  readonly body: unknown;
}

export interface GovernanceHttpAuthenticatedUnscopedRequest {
  readonly actor: { readonly kind: 'local_admin' };
  readonly route: GovernanceHttpRoute;
  readonly session: {
    readonly sessionId: string;
    readonly expiresAt: number;
  };
  readonly body: unknown;
}

export interface GovernanceHttpAuthorizedResponse {
  readonly status: number;
  readonly body?: unknown;
}

export interface GovernanceHttpServerOptions {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly adminToken?: string;
  readonly sessionTtlMs: number;
  readonly bodyLimitBytes: number;
  readonly bodyTimeoutMs: number;
  readonly now: () => number;
  readonly authorizedRoutes: readonly GovernanceHttpRoute[];
  readonly authenticatedUnscopedRoutes: readonly GovernanceHttpRoute[];
  readonly scopeHandles: GovernanceHttpScopeHandleStore;
  readonly resourceHandles: GovernanceHttpResourceHandleStore;
  readonly previewHandles: GovernanceHttpPreviewHandleStore;
  readonly handleAuthorizedRequest: (
    input: GovernanceHttpAuthorizedRequest,
  ) => GovernanceHttpAuthorizedResponse | Promise<GovernanceHttpAuthorizedResponse>;
  readonly handleAuthenticatedUnscopedRequest: (
    input: GovernanceHttpAuthenticatedUnscopedRequest,
  ) => GovernanceHttpAuthorizedResponse | Promise<GovernanceHttpAuthorizedResponse>;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

interface GovernanceHttpResourceRouteMatch {
  readonly route: GovernanceHttpRoute;
  readonly handle: string | null;
}

interface GovernanceHttpResourceRoutePattern {
  readonly basePath: string;
  readonly suffix: string;
}

interface BodyReadSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface BodyReadFailure {
  readonly ok: false;
  readonly status: 400 | 408 | 413;
  readonly error: 'bad_request' | 'request_timeout' | 'body_too_large';
  readonly closeConnection: boolean;
}

type BodyReadResult = BodyReadSuccess | BodyReadFailure;

export class GovernanceHttpServer {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly routes: ReadonlyMap<string, GovernanceHttpRoute>;
  private readonly resourceRoutes: readonly GovernanceHttpRoute[];
  private readonly authenticatedUnscopedRoutes: ReadonlyMap<string, GovernanceHttpRoute>;
  private readonly adminToken: string | null;
  private server: Server | null = null;

  constructor(private readonly options: GovernanceHttpServerOptions) {
    validateOptions(options);
    this.adminToken = options.adminToken ?? null;
    this.routes = new Map(
      options.authorizedRoutes
        .filter((route) => route.resourceKind === undefined)
        .map((route) => [routeKey(route.method, route.path), route]),
    );
    this.resourceRoutes = options.authorizedRoutes
      .filter((route) => route.resourceKind !== undefined);
    this.authenticatedUnscopedRoutes = new Map(
      options.authenticatedUnscopedRoutes
        .map((route) => [routeKey(route.method, route.path), route]),
    );
  }

  start(): Promise<void> {
    if (!this.options.enabled || this.server?.listening) {
      return Promise.resolve();
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        this.respondJson(response, 503, { error: 'unavailable' });
      });
    });
    this.server = server;

    return new Promise((resolve, reject) => {
      const handleListenError = (error: Error): void => {
        server.off('listening', handleListening);
        this.server = null;
        reject(error);
      };
      const handleListening = (): void => {
        server.off('error', handleListenError);
        resolve();
      };
      server.once('error', handleListenError);
      server.once('listening', handleListening);
      server.listen(this.options.port, this.options.host);
    });
  }

  close(): Promise<void> {
    this.sessions.clear();
    this.options.scopeHandles.clear();
    this.options.resourceHandles.clear();
    this.options.previewHandles.clear();
    const server = this.server;
    this.server = null;
    if (!server?.listening) {
      return Promise.resolve();
    }
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

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', this.expectedOrigin());
    const method = normalizeMethod(request.method);
    if (!method) {
      this.respondJson(response, 404, { error: 'not_found' });
      return;
    }

    const browserAsset = method === 'GET' && requestUrl.search.length === 0
      ? getGovernanceBrowserAsset(requestUrl.pathname)
      : null;
    if (browserAsset) {
      this.respondBrowserAsset(response, browserAsset);
      return;
    }

    if (requestUrl.pathname === SESSION_PATH) {
      await this.handleSessionRequest(method, request, response);
      return;
    }

    const key = routeKey(method, requestUrl.pathname);
    const authenticatedUnscopedRoute = this.authenticatedUnscopedRoutes.get(key);
    const staticRoute = this.routes.get(key);
    const resourceRoute = staticRoute || authenticatedUnscopedRoute
      ? null
      : this.matchResourceRoute(method, requestUrl.pathname);
    const route = staticRoute ?? resourceRoute?.route;
    const matchedRoute = route ?? authenticatedUnscopedRoute;
    if (!matchedRoute) {
      this.respondJson(response, 404, { error: 'not_found' });
      return;
    }

    const session = this.authenticate(request);
    if (!session) {
      this.respondJson(response, 401, { error: 'unauthorized' });
      return;
    }

    if (matchedRoute.mutation && !this.hasValidMutationEvidence(request, session)) {
      this.respondJson(response, 403, { error: 'forbidden' }, true);
      return;
    }

    let body: unknown;
    if (matchedRoute.mutation) {
      if (!isJsonContentType(request.headers['content-type'])) {
        this.respondJson(response, 400, { error: 'bad_request' }, true);
        return;
      }
      const bodyResult = await this.readJsonBody(request);
      if (!bodyResult.ok) {
        this.respondJson(
          response,
          bodyResult.status,
          { error: bodyResult.error },
          bodyResult.closeConnection,
        );
        return;
      }
      body = bodyResult.value;
    }

    if (requestUrl.search.length > 0) {
      this.respondJson(response, 400, { error: 'bad_request' });
      return;
    }
    if (authenticatedUnscopedRoute) {
      if (request.headers[SCOPE_HEADER] !== undefined) {
        this.respondJson(response, 400, { error: 'bad_request' });
        return;
      }
      let result: GovernanceHttpAuthorizedResponse;
      try {
        result = await this.options.handleAuthenticatedUnscopedRequest({
          actor: { kind: 'local_admin' },
          route: authenticatedUnscopedRoute,
          session: {
            sessionId: session.sessionId,
            expiresAt: session.expiresAt,
          },
          body,
        });
      } catch {
        this.respondJson(response, 503, { error: 'unavailable' });
        return;
      }
      if (!isAuthorizedResponse(result)) {
        this.respondJson(response, 503, { error: 'unavailable' });
        return;
      }
      this.respondJson(response, result.status, result.body);
      return;
    }

    if (resourceRoute?.handle === null) {
      this.respondJson(response, 400, { error: 'bad_request' });
      return;
    }

    const scopeHandle = readOpaqueHeader(request, SCOPE_HEADER);
    if (!scopeHandle.ok) {
      this.respondJson(response, 400, { error: 'bad_request' });
      return;
    }

    let candidateScope: unknown;
    try {
      candidateScope = await this.options.scopeHandles.resolve({
        sessionId: session.sessionId,
        handle: scopeHandle.value,
        purpose: matchedRoute.purpose,
      });
    } catch {
      this.respondJson(response, 503, { error: 'unavailable' });
      return;
    }
    const scope = parseGovernanceScope(candidateScope);
    if (!scope) {
      this.respondJson(response, 404, { error: 'not_found' });
      return;
    }

    let resource: GovernanceHttpResolvedResource | undefined;
    if (resourceRoute) {
      let candidateResource: unknown;
      try {
        candidateResource = await this.options.resourceHandles.resolve({
          sessionId: session.sessionId,
          handle: resourceRoute.handle as string,
          purpose: matchedRoute.purpose,
          resourceKind: matchedRoute.resourceKind as string,
          scope,
        });
      } catch {
        this.respondJson(response, 503, { error: 'unavailable' });
        return;
      }
      resource = parseResolvedResource(candidateResource, matchedRoute.resourceKind as string)
        ?? undefined;
      if (!resource) {
        this.respondJson(response, 404, { error: 'not_found' });
        return;
      }
    }

    let result: GovernanceHttpAuthorizedResponse;
    try {
      result = await this.options.handleAuthorizedRequest({
        actor: { kind: 'local_admin' },
        route: matchedRoute,
        session: {
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
        },
        scope,
        ...(resource === undefined ? {} : { resource }),
        body,
      });
    } catch {
      this.respondJson(response, 503, { error: 'unavailable' });
      return;
    }
    if (!isAuthorizedResponse(result)) {
      this.respondJson(response, 503, { error: 'unavailable' });
      return;
    }
    this.respondJson(response, result.status, result.body);
  }

  private matchResourceRoute(
    method: GovernanceHttpMethod,
    pathname: string,
  ): GovernanceHttpResourceRouteMatch | null {
    for (const route of this.resourceRoutes) {
      if (route.method !== method) {
        continue;
      }
      const pattern = parseResourceRoutePattern(route.path);
      if (!pattern) {
        continue;
      }
      const prefix = `${pattern.basePath}/`;
      if (!pathname.startsWith(prefix)) {
        continue;
      }
      if (pattern.suffix && !pathname.endsWith(pattern.suffix)) {
        continue;
      }
      const segmentEnd = pathname.length - pattern.suffix.length;
      if (segmentEnd < prefix.length) {
        continue;
      }
      const segment = pathname.slice(prefix.length, segmentEnd);
      if (segment.includes('/')) {
        continue;
      }
      return {
        route,
        handle: OPAQUE_VALUE_PATTERN.test(segment) ? segment : null,
      };
    }
    return null;
  }

  private async handleSessionRequest(
    method: GovernanceHttpMethod,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (method === 'POST') {
      await this.handleLogin(request, response);
      return;
    }

    const session = this.authenticate(request);
    if (!session) {
      this.respondJson(response, 401, { error: 'unauthorized' });
      return;
    }

    if (method === 'GET') {
      this.respondJson(response, 200, {
        actor: 'local_admin',
        expiresAt: session.expiresAt,
      });
      return;
    }

    if (method === 'DELETE') {
      if (!this.hasValidMutationEvidence(request, session)) {
        this.respondJson(response, 403, { error: 'forbidden' }, true);
        return;
      }
      this.removeSession(session.sessionId);
      this.respondEmpty(response, 204, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/governance; Max-Age=0`,
      });
      return;
    }

    this.respondJson(response, 404, { error: 'not_found' });
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.hasExactOrigin(request)) {
      this.respondJson(response, 403, { error: 'forbidden' }, true);
      return;
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      this.respondJson(response, 400, { error: 'bad_request' }, true);
      return;
    }
    const bodyResult = await this.readJsonBody(request);
    if (!bodyResult.ok) {
      this.respondJson(
        response,
        bodyResult.status,
        { error: bodyResult.error },
        bodyResult.closeConnection,
      );
      return;
    }
    const token = parseLoginToken(bodyResult.value);
    if (token === undefined) {
      this.respondJson(response, 400, { error: 'bad_request' });
      return;
    }
    if (!this.adminToken || !equalSecret(token, this.adminToken)) {
      this.respondJson(response, 401, { error: 'unauthorized' });
      return;
    }

    this.pruneExpiredSessions();
    const priorSessionId = this.readSessionId(request);
    if (priorSessionId) {
      this.removeSession(priorSessionId);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      this.respondJson(response, 503, { error: 'unavailable' });
      return;
    }

    const sessionValue = randomOpaqueValue();
    const sessionId = digestSessionValue(sessionValue);
    const csrfToken = randomOpaqueValue();
    const expiresAt = this.options.now() + this.options.sessionTtlMs;
    this.sessions.set(sessionId, { sessionId, csrfToken, expiresAt });
    this.respondJson(response, 201, { csrfToken }, false, {
      'Set-Cookie': [
        `${SESSION_COOKIE}=${sessionValue}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/governance',
        `Max-Age=${Math.floor(this.options.sessionTtlMs / 1_000)}`,
      ].join('; '),
    });
  }

  private authenticate(request: IncomingMessage): SessionRecord | null {
    this.pruneExpiredSessions();
    const sessionId = this.readSessionId(request);
    return sessionId ? this.sessions.get(sessionId) ?? null : null;
  }

  private readSessionId(request: IncomingMessage): string | null {
    const sessionValue = readSessionCookie(request);
    return sessionValue ? digestSessionValue(sessionValue) : null;
  }

  private pruneExpiredSessions(): void {
    const now = this.options.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.removeSession(sessionId);
      }
    }
  }

  private removeSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.options.scopeHandles.revokeSession(sessionId);
      this.options.resourceHandles.revokeSession(sessionId);
      this.options.previewHandles.revokeSession(sessionId);
    }
  }

  private hasValidMutationEvidence(request: IncomingMessage, session: SessionRecord): boolean {
    if (!this.hasExactOrigin(request)) {
      return false;
    }
    const csrf = request.headers[CSRF_HEADER];
    return typeof csrf === 'string'
      && OPAQUE_VALUE_PATTERN.test(csrf)
      && equalSecret(csrf, session.csrfToken);
  }

  private hasExactOrigin(request: IncomingMessage): boolean {
    return request.headers.origin === this.expectedOrigin();
  }

  private expectedOrigin(): string {
    const host = this.options.host === '::1' ? '[::1]' : this.options.host;
    return `http://${host}:${this.options.port}`;
  }

  private readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
    const declaredLength = readContentLength(request);
    if (declaredLength === null) {
      return Promise.resolve({
        ok: false,
        status: 400,
        error: 'bad_request',
        closeConnection: true,
      });
    }
    if (declaredLength !== undefined && declaredLength > this.options.bodyLimitBytes) {
      request.resume();
      return Promise.resolve({
        ok: false,
        status: 413,
        error: 'body_too_large',
        closeConnection: true,
      });
    }

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let settled = false;

      const settle = (result: BodyReadResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.off('data', handleData);
        request.off('end', handleEnd);
        request.off('aborted', handleAborted);
        request.off('error', handleError);
        if (!result.ok && result.closeConnection) {
          request.resume();
        }
        resolve(result);
      };
      const handleData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > this.options.bodyLimitBytes) {
          settle({
            ok: false,
            status: 413,
            error: 'body_too_large',
            closeConnection: true,
          });
          return;
        }
        chunks.push(buffer);
      };
      const handleEnd = (): void => {
        try {
          settle({
            ok: true,
            value: JSON.parse(Buffer.concat(chunks, receivedBytes).toString('utf8')) as unknown,
          });
        } catch {
          settle({
            ok: false,
            status: 400,
            error: 'bad_request',
            closeConnection: false,
          });
        }
      };
      const handleAborted = (): void => {
        settle({
          ok: false,
          status: 400,
          error: 'bad_request',
          closeConnection: true,
        });
      };
      const handleError = (): void => handleAborted();
      const timeout = setTimeout(() => {
        settle({
          ok: false,
          status: 408,
          error: 'request_timeout',
          closeConnection: true,
        });
      }, this.options.bodyTimeoutMs);

      request.on('data', handleData);
      request.once('end', handleEnd);
      request.once('aborted', handleAborted);
      request.once('error', handleError);
    });
  }

  private respondJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    closeConnection = false,
    headers: Record<string, string> = {},
  ): void {
    if (response.writableEnded) {
      return;
    }
    let responseStatus = status;
    let payload: string;
    try {
      payload = body === undefined ? '' : JSON.stringify(body);
    } catch {
      responseStatus = 503;
      payload = JSON.stringify({ error: 'unavailable' });
    }
    response.writeHead(responseStatus, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      ...(closeConnection ? { Connection: 'close' } : {}),
      ...headers,
    });
    response.end(payload);
  }

  private respondBrowserAsset(
    response: ServerResponse,
    asset: GovernanceBrowserAsset,
  ): void {
    if (response.writableEnded) {
      return;
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.contentType,
      'Content-Length': String(Buffer.byteLength(asset.body, 'utf8')),
    });
    response.end(asset.body);
  }

  private respondEmpty(
    response: ServerResponse,
    status: number,
    headers: Record<string, string> = {},
  ): void {
    if (response.writableEnded) {
      return;
    }
    response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    response.end();
  }
}

function validateOptions(options: GovernanceHttpServerOptions): void {
  const validAdminToken = options.adminToken !== undefined
    && Buffer.byteLength(options.adminToken, 'utf8') >= 32
    && Buffer.byteLength(options.adminToken, 'utf8') <= 512
    && !containsControlCharacter(options.adminToken);
  const routes = [...options.authorizedRoutes, ...options.authenticatedUnscopedRoutes];
  const routeKeys = routes.map((route) => routeKey(route.method, route.path));
  const validRouteBasics = routes.every((route) => (
    route.path.startsWith(`${API_PREFIX}/`)
    && route.path !== SESSION_PATH
    && !route.path.includes('?')
    && route.purpose.length > 0
    && route.mutation === (route.method !== 'GET')
  ));
  const validAuthorizedRoutes = options.authorizedRoutes.every((route) => {
    if (route.resourceKind === undefined) {
      return !route.path.includes(':');
    }
    return parseResourceRoutePattern(route.path) !== null
      && isBoundedRouteValue(route.resourceKind, MAX_RESOURCE_KIND_LENGTH);
  });
  const validUnscopedRoutes = options.authenticatedUnscopedRoutes.every(
    (route) => route.resourceKind === undefined && !route.path.includes(':'),
  );
  const validRoutes = validRouteBasics
    && validAuthorizedRoutes
    && validUnscopedRoutes
    && new Set(routeKeys).size === routeKeys.length;
  const validScopeHandles = isRecord(options.scopeHandles)
    && typeof options.scopeHandles.resolve === 'function'
    && typeof options.scopeHandles.revokeSession === 'function'
    && typeof options.scopeHandles.clear === 'function';
  const validResourceHandles = isRecord(options.resourceHandles)
    && typeof options.resourceHandles.resolve === 'function'
    && typeof options.resourceHandles.revokeSession === 'function'
    && typeof options.resourceHandles.clear === 'function';
  const validPreviewHandles = isRecord(options.previewHandles)
    && typeof options.previewHandles.revokeSession === 'function'
    && typeof options.previewHandles.clear === 'function';
  const validHandlers = typeof options.handleAuthorizedRequest === 'function'
    && typeof options.handleAuthenticatedUnscopedRequest === 'function';
  if (
    (options.host !== '127.0.0.1' && options.host !== '::1')
    || !Number.isInteger(options.port)
    || options.port < 1
    || options.port > 65_535
    || !Number.isInteger(options.sessionTtlMs)
    || options.sessionTtlMs < 60_000
    || options.sessionTtlMs > 3_600_000
    || !Number.isInteger(options.bodyLimitBytes)
    || options.bodyLimitBytes < 1
    || !Number.isInteger(options.bodyTimeoutMs)
    || options.bodyTimeoutMs < 1
    || !validRoutes
    || !validScopeHandles
    || !validResourceHandles
    || !validPreviewHandles
    || !validHandlers
    || (options.enabled && !validAdminToken)
  ) {
    throw new Error('Invalid governance HTTP configuration');
  }
}

function normalizeMethod(value: string | undefined): GovernanceHttpMethod | null {
  switch (value) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
      return value;
    default:
      return null;
  }
}

function routeKey(method: GovernanceHttpMethod, path: string): string {
  return `${method} ${path}`;
}

function parseResourceRoutePattern(path: string): GovernanceHttpResourceRoutePattern | null {
  const parameterIndex = path.indexOf(RESOURCE_PATH_PARAMETER);
  if (
    parameterIndex < 0
    || path.indexOf(
      RESOURCE_PATH_PARAMETER,
      parameterIndex + RESOURCE_PATH_PARAMETER.length,
    ) >= 0
  ) {
    return null;
  }
  const basePath = path.slice(0, parameterIndex);
  const suffix = path.slice(parameterIndex + RESOURCE_PATH_PARAMETER.length);
  return basePath.length > 0
    && !basePath.endsWith('/')
    && !basePath.includes(':')
    && RESOURCE_ROUTE_SUFFIX_PATTERN.test(suffix)
    ? { basePath, suffix }
    : null;
}

function parseLoginToken(value: unknown): string | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['token']) || typeof value.token !== 'string') {
    return undefined;
  }
  return value.token;
}

function readSessionCookie(request: IncomingMessage): string | null {
  const cookieHeaders: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'cookie') {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) {
        cookieHeaders.push(value);
      }
    }
  }
  if (cookieHeaders.length !== 1) {
    return null;
  }
  const matches = cookieHeaders[0]?.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`)) ?? [];
  if (matches.length !== 1) {
    return null;
  }
  const value = matches[0]?.slice(SESSION_COOKIE.length + 1) ?? '';
  return OPAQUE_VALUE_PATTERN.test(value) ? value : null;
}

function readOpaqueHeader(
  request: IncomingMessage,
  name: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  const value = request.headers[name];
  return typeof value === 'string' && OPAQUE_VALUE_PATTERN.test(value)
    ? { ok: true, value }
    : { ok: false };
}

function readContentLength(request: IncomingMessage): number | undefined | null {
  const value = request.headers['content-length'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  return typeof value === 'string'
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function digestSessionValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function parseGovernanceScope(value: unknown): GovernanceScope | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  switch (value.kind) {
    case 'global':
    case 'system':
      return hasExactKeys(value, ['kind']) ? { kind: value.kind } : null;
    case 'user':
      return hasExactKeys(value, ['kind', 'canonicalUserId']) && isNonEmptyString(value.canonicalUserId)
        ? { kind: 'user', canonicalUserId: value.canonicalUserId }
        : null;
    case 'group':
      return hasExactKeys(value, ['kind', 'groupId']) && isNonEmptyString(value.groupId)
        ? { kind: 'group', groupId: value.groupId }
        : null;
    case 'tool':
      return hasExactKeys(value, ['kind', 'toolName']) && isNonEmptyString(value.toolName)
        ? { kind: 'tool', toolName: value.toolName }
        : null;
    case 'conversation': {
      if (!isNonEmptyString(value.conversationId)) {
        return null;
      }
      if (
        value.conversationType === 'private'
        && hasExactKeys(value, ['kind', 'conversationId', 'conversationType'])
      ) {
        return {
          kind: 'conversation',
          conversationId: value.conversationId,
          conversationType: 'private',
        };
      }
      if (
        value.conversationType === 'group'
        && isNonEmptyString(value.groupId)
        && hasExactKeys(value, ['kind', 'conversationId', 'conversationType', 'groupId'])
      ) {
        return {
          kind: 'conversation',
          conversationId: value.conversationId,
          conversationType: 'group',
          groupId: value.groupId,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function parseResolvedResource(
  value: unknown,
  expectedKind: string,
): GovernanceHttpResolvedResource | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['kind', 'resourceId'])
    || value.kind !== expectedKind
    || !isBoundedRouteValue(value.resourceId, MAX_RESOURCE_IDENTIFIER_LENGTH)
  ) {
    return null;
  }
  return { kind: expectedKind, resourceId: value.resourceId };
}

function isAuthorizedResponse(value: unknown): value is GovernanceHttpAuthorizedResponse {
  return isRecord(value)
    && Number.isInteger(value.status)
    && typeof value.status === 'number'
    && value.status >= 200
    && value.status <= 599
    && hasOnlyKeys(value, ['status', 'body']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function isBoundedRouteValue(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && value.trim() === value
    && !containsControlCharacter(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
