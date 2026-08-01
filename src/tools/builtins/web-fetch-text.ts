import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import type { ToolHandlerRequest, ToolRegistryEntry } from '../../types/tool.js';
import { redactFileOperationText } from '../file-operations/redaction.js';

const MAX_ALLOWED_ORIGINS = 16;
const MAX_URL_LENGTH = 2048;
const MAX_RESPONSE_BYTES = 2048;
const MAX_OUTPUT_BYTES = 8192;
const MAX_REDIRECTS = 3;
const MAX_RESOLVED_ADDRESSES = 16;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NON_PUBLIC_IPV4 = createNonPublicIpv4BlockList();
const GLOBAL_IPV6 = createGlobalIpv6BlockList();
const NON_PUBLIC_IPV6 = createNonPublicIpv6BlockList();

export interface WebFetchAddress {
  address: string;
  family: 4 | 6;
}

export type WebFetchResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly WebFetchAddress[]>;

export interface WebFetchTransportRequest {
  url: string;
  hostname: string;
  port: number;
  address: WebFetchAddress;
  signal: AbortSignal;
}

export interface WebFetchTransportResponse {
  status: number;
  statusText?: string;
  headers: {
    location?: string;
    contentType?: string;
    contentLength?: string;
    contentEncoding?: string;
  };
  body: AsyncIterable<Uint8Array>;
  dispose(): void;
}

export type WebFetchTransport = (
  request: WebFetchTransportRequest,
) => Promise<WebFetchTransportResponse>;

export interface WebFetchHttpsResponse extends AsyncIterable<Uint8Array> {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  destroy(): void;
}

export interface WebFetchHttpsClientRequest {
  once(event: 'error', listener: (error: Error) => void): unknown;
  end(): void;
}

export type WebFetchHttpsRequestFactory = (
  url: string,
  options: HttpsRequestOptions,
  onResponse: (response: WebFetchHttpsResponse) => void,
) => WebFetchHttpsClientRequest;

export interface WebFetchTextDependencies {
  allowedOrigins: readonly string[];
  resolveHost?: WebFetchResolver;
  request?: WebFetchTransport;
}

export interface WebFetchTextOutput {
  url: string;
  status: number;
  contentType: string;
  content: string;
  bytes: number;
  redirects: number;
  redactionApplied: boolean;
}

class WebFetchTextError extends Error {}

export function createWebFetchTextTool(
  dependencies: WebFetchTextDependencies,
): ToolRegistryEntry {
  const allowedOrigins = normalizeAllowedOrigins(dependencies.allowedOrigins);
  const allowedOriginSet = new Set(allowedOrigins);
  const resolveHost = dependencies.resolveHost ?? resolvePublicAddresses;
  const request = dependencies.request ?? createPinnedHttpsTransport();

  return {
    name: 'web.fetch_text',
    version: '1.0.0',
    description: 'Fetch one bounded UTF-8 text response from a configured exact HTTPS origin.',
    capabilities: ['network', 'external_side_effect'],
    permissions: {
      allowedActors: ['owner', 'admin'],
      allowedContexts: ['private_chat'],
    },
    evaluatorPolicy: 'required',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'restricted',
      execution: 'in_process',
      maxRuntimeMs: 5000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      allowedOrigins: [...allowedOrigins],
    },
    outputSensitivity: 'secret_possible',
    piSchema: {
      input: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            maxLength: MAX_URL_LENGTH,
            description: 'HTTPS URL beneath one configured exact origin.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          url: { type: 'string', maxLength: MAX_URL_LENGTH },
          status: { type: 'number' },
          contentType: { type: 'string' },
          content: { type: 'string', maxLength: 8192 },
          bytes: { type: 'number', maximum: MAX_RESPONSE_BYTES },
          redirects: { type: 'number', maximum: MAX_REDIRECTS },
          redactionApplied: { type: 'boolean' },
        },
        required: [
          'url',
          'status',
          'contentType',
          'content',
          'bytes',
          'redirects',
          'redactionApplied',
        ],
        additionalProperties: false,
      },
    },
    handler: createWebFetchTextHandler({
      allowedOrigins: allowedOriginSet,
      resolveHost,
      request,
    }),
  };
}

function createWebFetchTextHandler(dependencies: {
  allowedOrigins: ReadonlySet<string>;
  resolveHost: WebFetchResolver;
  request: WebFetchTransport;
}): ToolRegistryEntry['handler'] {
  return async (request: ToolHandlerRequest): Promise<WebFetchTextOutput> => {
    try {
      throwIfAborted(request.signal);
      if (!isNonEmptyString(request.evaluatorDecisionId)) {
        throw new WebFetchTextError('web.fetch_text approval is required');
      }

      let target = parseInputUrl(request.input, dependencies.allowedOrigins);
      let redirects = 0;

      while (true) {
        throwIfAborted(request.signal);
        const hostname = normalizeUrlHostname(target.hostname);
        const address = await resolvePinnedAddress(
          hostname,
          request.signal,
          dependencies.resolveHost,
        );
        throwIfAborted(request.signal);

        let response: WebFetchTransportResponse;
        try {
          response = await dependencies.request({
            url: target.href,
            hostname,
            port: readHttpsPort(target),
            address,
            signal: request.signal,
          });
        } catch {
          throwIfAborted(request.signal);
          throw new WebFetchTextError('web.fetch_text is unavailable');
        }

        try {
          throwIfAborted(request.signal);
          if (REDIRECT_STATUSES.has(response.status)) {
            if (redirects >= MAX_REDIRECTS) {
              throw new WebFetchTextError('web.fetch_text redirect limit exceeded');
            }
            target = parseRedirectUrl(
              response.headers.location,
              target,
              dependencies.allowedOrigins,
            );
            redirects += 1;
            continue;
          }

          if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
            throw new WebFetchTextError('web.fetch_text request failed');
          }
          const contentType = parseTextContentType(response.headers.contentType);
          assertIdentityEncoding(response.headers.contentEncoding);
          assertDeclaredBodyLength(response.headers.contentLength);
          const { content, bytes } = await readBoundedUtf8Body(response.body, request.signal);
          const redactedUrl = redactFileOperationText(target.href);
          const redactedContent = redactFileOperationText(content);

          const output: WebFetchTextOutput = {
            url: redactedUrl.text,
            status: response.status,
            contentType,
            content: redactedContent.text,
            bytes,
            redirects,
            redactionApplied: redactedUrl.redacted || redactedContent.redacted,
          };
          if (Buffer.byteLength(JSON.stringify(output)) > MAX_OUTPUT_BYTES) {
            throw new WebFetchTextError('web.fetch_text response is too large');
          }
          return output;
        } finally {
          disposeResponse(response);
        }
      }
    } catch (error) {
      if (error instanceof WebFetchTextError) {
        throw error;
      }
      if (request.signal.aborted) {
        throw new WebFetchTextError('web.fetch_text aborted');
      }
      throw new WebFetchTextError('web.fetch_text is unavailable');
    }
  };
}

function normalizeAllowedOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_ALLOWED_ORIGINS) {
    throw new WebFetchTextError('web.fetch_text configuration is invalid');
  }

  const normalized: string[] = [];
  for (const value of origins) {
    if (!isNonEmptyString(value) || value.length > MAX_URL_LENGTH) {
      throw new WebFetchTextError('web.fetch_text configuration is invalid');
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new WebFetchTextError('web.fetch_text configuration is invalid');
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.hostname.length === 0
      || parsed.hostname.includes('*')
      || parsed.origin.length > MAX_URL_LENGTH
      || value !== value.trim()
      || hasUrlControlOrBackslash(value)
    ) {
      throw new WebFetchTextError('web.fetch_text configuration is invalid');
    }
    normalized.push(parsed.origin);
  }

  if (new Set(normalized).size !== normalized.length) {
    throw new WebFetchTextError('web.fetch_text configuration is invalid');
  }
  return normalized;
}

function parseInputUrl(input: unknown, allowedOrigins: ReadonlySet<string>): URL {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 1
    || !Object.prototype.hasOwnProperty.call(input, 'url')
  ) {
    throw new WebFetchTextError('web.fetch_text input is not allowed');
  }
  const value = (input as { url?: unknown }).url;
  if (!isNonEmptyString(value) || value.length > MAX_URL_LENGTH) {
    throw new WebFetchTextError('web.fetch_text input is not allowed');
  }
  return parseAllowedTarget(value, allowedOrigins, 'web.fetch_text input is not allowed');
}

function parseRedirectUrl(
  location: string | undefined,
  current: URL,
  allowedOrigins: ReadonlySet<string>,
): URL {
  if (!isNonEmptyString(location) || location.length > MAX_URL_LENGTH) {
    throw new WebFetchTextError('web.fetch_text redirect is not allowed');
  }
  let resolved: string;
  try {
    const candidate = new URL(location, current);
    if (candidate.origin !== current.origin) {
      throw new WebFetchTextError('web.fetch_text redirect is not allowed');
    }
    resolved = candidate.href;
  } catch {
    throw new WebFetchTextError('web.fetch_text redirect is not allowed');
  }
  return parseAllowedTarget(resolved, allowedOrigins, 'web.fetch_text redirect is not allowed');
}

function parseAllowedTarget(
  value: string,
  allowedOrigins: ReadonlySet<string>,
  failure: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebFetchTextError(failure);
  }
  if (
    value.length > MAX_URL_LENGTH
    || parsed.href.length > MAX_URL_LENGTH
    || value !== value.trim()
    || hasUrlControlOrBackslash(value)
    || parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || value.includes('#')
    || !allowedOrigins.has(parsed.origin)
    || hasSensitiveUrlData(parsed)
  ) {
    throw new WebFetchTextError(failure);
  }
  return parsed;
}

function hasSensitiveUrlData(url: URL): boolean {
  const encoded = `${url.pathname}${url.search}`;
  const candidates = [url.hostname, encoded];
  let decoded = encoded;
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      candidates.push(next);
      decoded = next;
    } catch {
      return true;
    }
  }
  return candidates.some((candidate) => redactFileOperationText(candidate).redacted);
}

async function resolvePinnedAddress(
  hostname: string,
  signal: AbortSignal,
  resolver: WebFetchResolver,
): Promise<WebFetchAddress> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicNetworkAddress(hostname)) {
      throw new WebFetchTextError('web.fetch_text destination is not allowed');
    }
    return { address: hostname, family: literalFamily };
  }

  let addresses: readonly WebFetchAddress[];
  try {
    addresses = await resolver(hostname, signal);
  } catch {
    throwIfAborted(signal);
    throw new WebFetchTextError('web.fetch_text is unavailable');
  }
  throwIfAborted(signal);
  if (
    addresses.length === 0
    || addresses.length > MAX_RESOLVED_ADDRESSES
    || addresses.some((entry) =>
      (entry.family !== 4 && entry.family !== 6)
      || isIP(entry.address) !== entry.family
      || !isPublicNetworkAddress(entry.address)
    )
  ) {
    throw new WebFetchTextError('web.fetch_text destination is not allowed');
  }
  const selected = addresses[0];
  if (!selected) {
    throw new WebFetchTextError('web.fetch_text destination is not allowed');
  }
  return { ...selected };
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !NON_PUBLIC_IPV4.check(address, 'ipv4');
  }
  if (family === 6) {
    return GLOBAL_IPV6.check(address, 'ipv6')
      && !NON_PUBLIC_IPV6.check(address, 'ipv6');
  }
  return false;
}

async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly WebFetchAddress[]> {
  throwIfAborted(signal);
  const resolved = await raceWithAbort(
    lookup(hostname, { all: true, verbatim: true }),
    signal,
  );
  throwIfAborted(signal);
  return resolved.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}

export function createPinnedHttpsTransport(
  requestFactory: WebFetchHttpsRequestFactory = nodeHttpsRequest,
): WebFetchTransport {
  return async (input: WebFetchTransportRequest): Promise<WebFetchTransportResponse> => {
    throwIfAborted(input.signal);
    return new Promise((resolve, reject) => {
      const request = requestFactory(input.url, {
        method: 'GET',
        agent: false,
        family: input.address.family,
        signal: input.signal,
        maxHeaderSize: 16_384,
        headers: {
          Accept: 'text/plain, text/html, text/markdown, text/csv, application/json, application/xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'LetheBot/1.0',
          Connection: 'close',
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ ...input.address }]);
            return;
          }
          callback(null, input.address.address, input.address.family);
        },
      }, (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: selectResponseHeaders(response.headers),
          body: response,
          dispose: () => response.destroy(),
        });
      });
      request.once('error', reject);
      request.end();
    });
  };
}

function nodeHttpsRequest(
  url: string,
  options: HttpsRequestOptions,
  onResponse: (response: WebFetchHttpsResponse) => void,
): WebFetchHttpsClientRequest {
  return httpsRequest(url, options, onResponse);
}

function selectResponseHeaders(headers: IncomingHttpHeaders): WebFetchTransportResponse['headers'] {
  return {
    location: readSingleHeader(headers.location),
    contentType: readSingleHeader(headers['content-type']),
    contentLength: readSingleHeader(headers['content-length']),
    contentEncoding: readSingleHeader(headers['content-encoding']),
  };
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseTextContentType(value: string | undefined): string {
  if (!isNonEmptyString(value) || value.length > 256) {
    throw new WebFetchTextError('web.fetch_text response is not text');
  }
  const [rawMediaType, ...parameters] = value.split(';');
  const mediaType = rawMediaType?.trim().toLowerCase();
  if (!mediaType || !isAllowedTextMediaType(mediaType)) {
    throw new WebFetchTextError('web.fetch_text response is not text');
  }
  for (const parameter of parameters) {
    const [rawName, rawValue, ...rest] = parameter.split('=');
    if (rest.length > 0 || !rawName || rawValue === undefined) {
      throw new WebFetchTextError('web.fetch_text response is not text');
    }
    if (rawName.trim().toLowerCase() !== 'charset') {
      continue;
    }
    const charset = rawValue.trim().replace(/^"|"$/g, '').toLowerCase();
    if (charset !== 'utf-8' && charset !== 'utf8') {
      throw new WebFetchTextError('web.fetch_text response is not UTF-8');
    }
  }
  return mediaType;
}

function isAllowedTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType.endsWith('+json')
    || mediaType === 'application/xml'
    || mediaType.endsWith('+xml')
    || mediaType === 'application/xhtml+xml';
}

function assertIdentityEncoding(value: string | undefined): void {
  if (value !== undefined && value.trim().toLowerCase() !== 'identity') {
    throw new WebFetchTextError('web.fetch_text response encoding is not allowed');
  }
}

function assertDeclaredBodyLength(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new WebFetchTextError('web.fetch_text is unavailable');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
    throw new WebFetchTextError('web.fetch_text response is too large');
  }
}

async function readBoundedUtf8Body(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<{ content: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    throwIfAborted(signal);
    if (!(chunk instanceof Uint8Array)) {
      throw new WebFetchTextError('web.fetch_text is unavailable');
    }
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new WebFetchTextError('web.fetch_text response is too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  throwIfAborted(signal);

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    throw new WebFetchTextError('web.fetch_text response is not UTF-8');
  }
  if (hasDisallowedControlCharacter(content)) {
    throw new WebFetchTextError('web.fetch_text response is not text');
  }
  return { content, bytes };
}

function hasDisallowedControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined
      && ((codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13)
        || codePoint === 127);
  });
}

function readHttpsPort(url: URL): number {
  if (url.port === '') {
    return 443;
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WebFetchTextError('web.fetch_text input is not allowed');
  }
  return port;
}

function disposeResponse(response: WebFetchTransportResponse): void {
  try {
    response.dispose();
  } catch {
    // Disposal is best-effort after the response has already reached a terminal path.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WebFetchTextError('web.fetch_text aborted');
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new WebFetchTextError('web.fetch_text aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new WebFetchTextError('web.fetch_text aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasUrlControlOrBackslash(value: string): boolean {
  return value.includes('\\') || Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function createNonPublicIpv4BlockList(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(address, prefix, 'ipv4');
  }
  return list;
}

function createGlobalIpv6BlockList(): BlockList {
  const list = new BlockList();
  list.addSubnet('2000::', 3, 'ipv6');
  return list;
}

function createNonPublicIpv6BlockList(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of [
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
  ] as const) {
    list.addSubnet(address, prefix, 'ipv6');
  }
  return list;
}
