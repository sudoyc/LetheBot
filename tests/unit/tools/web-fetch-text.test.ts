import { TextEncoder } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWebFetchTextTool,
  createPinnedHttpsTransport,
  isPublicNetworkAddress,
  type WebFetchAddress,
  type WebFetchHttpsRequestFactory,
  type WebFetchResolver,
  type WebFetchTextOutput,
  type WebFetchTransport,
  type WebFetchTransportResponse,
} from '../../../src/tools/builtins/web-fetch-text';
import { ToolRegistry } from '../../../src/tools/registry';
import type { ToolHandlerRequest } from '../../../src/types/tool';

const ALLOWED_ORIGIN = 'https://docs.example.invalid';
const PUBLIC_ADDRESS: WebFetchAddress = {
  address: '93.184.216.34',
  family: 4,
};
const encoder = new TextEncoder();

describe('built-in web.fetch_text tool', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('declares exact restricted-network metadata and private owner/admin permissions', () => {
    const { entry } = createHarness();
    const registry = new ToolRegistry();
    registry.register(entry);

    expect(entry).toMatchObject({
      name: 'web.fetch_text',
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
        maxOutputBytes: 8192,
        allowedOrigins: [ALLOWED_ORIGIN],
      },
      outputSensitivity: 'secret_possible',
      piSchema: {
        input: {
          required: ['url'],
          additionalProperties: false,
        },
        output: {
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
    });
    expect(registry.checkPermission(
      'web.fetch_text',
      { actorClass: 'owner' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'web.fetch_text',
      { actorClass: 'admin' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'web.fetch_text',
      { actorClass: 'trusted_user' },
      'private_chat',
    )).toBe(false);
    expect(registry.checkPermission(
      'web.fetch_text',
      { actorClass: 'owner' },
      'group_chat',
    )).toBe(false);
  });

  it('requires persisted evaluator approval before resolver or transport access', async () => {
    const { entry, resolveHost, request } = createHarness();

    await expect(entry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/guide` }, {
      evaluatorDecisionId: undefined,
    }))).rejects.toThrow('web.fetch_text approval is required');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('pins a public resolved address and returns only bounded redacted text metadata', async () => {
    const secret = 'sk-web-fetch-secret-abcdefghijklmnopqrstuvwxyz';
    const source = `Guide\napi_key=${secret}\ncontact 12345`;
    const { entry, resolveHost, request, dispose } = createHarness({
      response: response({
        body: [source.slice(0, 8), source.slice(8)],
        contentType: 'text/plain; charset=utf-8',
      }),
    });

    const output = await entry.handler(
      toolRequest({ url: `${ALLOWED_ORIGIN}/guide?lang=en` }),
    ) as WebFetchTextOutput;
    const serialized = JSON.stringify(output);

    expect(resolveHost).toHaveBeenCalledWith(
      'docs.example.invalid',
      expect.any(AbortSignal),
    );
    expect(request).toHaveBeenCalledWith({
      url: `${ALLOWED_ORIGIN}/guide?lang=en`,
      hostname: 'docs.example.invalid',
      port: 443,
      address: PUBLIC_ADDRESS,
      signal: expect.any(AbortSignal),
    });
    expect(output).toEqual({
      url: `${ALLOWED_ORIGIN}/guide?lang=en`,
      status: 200,
      contentType: 'text/plain',
      content: expect.stringContaining('Guide'),
      bytes: Buffer.byteLength(source),
      redirects: 0,
      redactionApplied: true,
    });
    expect(output.content).toContain('[REDACTED:api_key_assignment]');
    expect(output.content).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('12345');
    expect(output).not.toHaveProperty('headers');
    expect(output).not.toHaveProperty('statusText');
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('uses one pinned header-fixed GET in the production HTTPS transport adapter', async () => {
    const destroy = vi.fn();
    const end = vi.fn();
    const once = vi.fn();
    const remoteResponse = {
      statusCode: 200,
      headers: {
        location: '/next',
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '2',
        'content-encoding': 'identity',
        'x-remote-secret': 'must not be projected',
      },
      destroy,
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield encoder.encode('ok');
      },
    };
    const requestFactory = vi.fn<WebFetchHttpsRequestFactory>(
      (_url, _options, onResponse) => {
        onResponse(remoteResponse);
        return { once, end };
      },
    );
    const signal = new AbortController().signal;
    const transport = createPinnedHttpsTransport(requestFactory);

    const result = await transport({
      url: `${ALLOWED_ORIGIN}/guide`,
      hostname: 'docs.example.invalid',
      port: 443,
      address: PUBLIC_ADDRESS,
      signal,
    });

    expect(requestFactory).toHaveBeenCalledOnce();
    const [url, options] = requestFactory.mock.calls[0] ?? [];
    expect(url).toBe(`${ALLOWED_ORIGIN}/guide`);
    expect(options).toMatchObject({
      method: 'GET',
      agent: false,
      family: 4,
      signal,
      maxHeaderSize: 16_384,
      headers: {
        Accept: 'text/plain, text/html, text/markdown, text/csv, application/json, application/xml',
        'Accept-Encoding': 'identity',
        'User-Agent': 'LetheBot/1.0',
        Connection: 'close',
      },
    });
    expect(JSON.stringify(options?.headers)).not.toContain('Authorization');
    expect(JSON.stringify(options?.headers)).not.toContain('Cookie');
    expect(once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(end).toHaveBeenCalledOnce();

    const lookup = options?.lookup;
    expect(lookup).toBeTypeOf('function');
    const singleCallback = vi.fn();
    lookup?.('docs.example.invalid', { all: false }, singleCallback);
    expect(singleCallback).toHaveBeenCalledWith(null, PUBLIC_ADDRESS.address, 4);
    const allCallback = vi.fn();
    lookup?.('docs.example.invalid', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [PUBLIC_ADDRESS]);

    expect(result).toMatchObject({
      status: 200,
      headers: {
        location: '/next',
        contentType: 'text/plain; charset=utf-8',
        contentLength: '2',
        contentEncoding: 'identity',
      },
    });
    expect(result.headers).not.toHaveProperty('x-remote-secret');
    result.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('follows at most same-origin redirects and resolves and pins every hop', async () => {
    const resolveHost = vi.fn<WebFetchResolver>()
      .mockResolvedValueOnce([PUBLIC_ADDRESS])
      .mockResolvedValueOnce([{ address: '93.184.216.35', family: 4 }]);
    const firstDispose = vi.fn();
    const finalDispose = vi.fn();
    const request = vi.fn<WebFetchTransport>()
      .mockResolvedValueOnce(response({
        status: 302,
        location: '/final',
        dispose: firstDispose,
      }))
      .mockResolvedValueOnce(response({
        body: ['done'],
        dispose: finalDispose,
      }));
    const entry = createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN],
      resolveHost,
      request,
    });

    const output = await entry.handler(
      toolRequest({ url: `${ALLOWED_ORIGIN}/start` }),
    ) as WebFetchTextOutput;

    expect(output).toMatchObject({
      url: `${ALLOWED_ORIGIN}/final`,
      redirects: 1,
      content: 'done',
    });
    expect(resolveHost).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: `${ALLOWED_ORIGIN}/final`,
      address: { address: '93.184.216.35', family: 4 },
    }));
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(finalDispose).toHaveBeenCalledOnce();
  });

  it('rejects a redirect to another configured origin', async () => {
    const request = vi.fn<WebFetchTransport>().mockResolvedValue(response({
      status: 302,
      location: 'https://api.example.invalid/final',
    }));
    const entry = createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN, 'https://api.example.invalid'],
      resolveHost: vi.fn<WebFetchResolver>().mockResolvedValue([PUBLIC_ADDRESS]),
      request,
    });

    await expect(entry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/start` })))
      .rejects.toThrow('web.fetch_text redirect is not allowed');
    expect(request).toHaveBeenCalledOnce();
  });

  it('uses a validated public literal address without consulting DNS', async () => {
    const resolveHost = vi.fn<WebFetchResolver>();
    const request = vi.fn<WebFetchTransport>().mockResolvedValue(response({ body: ['literal'] }));
    const origin = 'https://[2606:4700:4700::1111]';
    const entry = createWebFetchTextTool({
      allowedOrigins: [origin],
      resolveHost,
      request,
    });

    await expect(entry.handler(toolRequest({ url: `${origin}/guide` })))
      .resolves.toMatchObject({ content: 'literal' });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '2606:4700:4700::1111',
      address: { address: '2606:4700:4700::1111', family: 6 },
    }));
  });

  it('rejects a non-public literal address before DNS or transport access', async () => {
    const resolveHost = vi.fn<WebFetchResolver>();
    const request = vi.fn<WebFetchTransport>();
    const origin = 'https://127.0.0.1';
    const entry = createWebFetchTextTool({
      allowedOrigins: [origin],
      resolveHost,
      request,
    });

    await expect(entry.handler(toolRequest({ url: `${origin}/guide` })))
      .rejects.toThrow('web.fetch_text destination is not allowed');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a configured platform-shaped hostname before DNS or transport access', async () => {
    const resolveHost = vi.fn<WebFetchResolver>();
    const request = vi.fn<WebFetchTransport>();
    const origin = 'https://qq-12345.example.invalid';
    const entry = createWebFetchTextTool({
      allowedOrigins: [origin],
      resolveHost,
      request,
    });

    await expect(entry.handler(toolRequest({ url: `${origin}/guide` })))
      .rejects.toThrow('web.fetch_text input is not allowed');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { url: '' },
    { url: 'not-a-url' },
    { url: 'http://docs.example.invalid/guide' },
    { url: 'https://user@docs.example.invalid/guide' },
    { url: `${ALLOWED_ORIGIN}/guide#fragment` },
    { url: ` ${ALLOWED_ORIGIN}/guide` },
    { url: `${ALLOWED_ORIGIN}\\guide` },
    { url: `${ALLOWED_ORIGIN}/guide`, method: 'POST' },
    { url: `https://other.example.invalid/guide` },
    { url: `${ALLOWED_ORIGIN}/api_key=sk-${'x'.repeat(24)}` },
    { url: `${ALLOWED_ORIGIN}/users/12345` },
    { url: `${ALLOWED_ORIGIN}/${'a'.repeat(2049)}` },
  ])('rejects malformed, non-allowlisted, or sensitive input before resolution: %j', async (input) => {
    const { entry, resolveHost, request } = createHarness();

    await expect(entry.handler(toolRequest(input)))
      .rejects.toThrow('web.fetch_text input is not allowed');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    'invalid-address',
  ])('rejects non-public network address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
  ])('accepts public network address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });

  it.each([
    { label: 'empty DNS result', addresses: [] },
    {
      label: 'private DNS result',
      addresses: [{ address: '127.0.0.1', family: 4 }],
    },
    {
      label: 'mixed public/private DNS result',
      addresses: [PUBLIC_ADDRESS, { address: '10.0.0.1', family: 4 }],
    },
    {
      label: 'malformed family result',
      addresses: [{ address: '93.184.216.34', family: 6 }],
    },
  ])('rejects $label before transport access', async ({ addresses }) => {
    const { entry, resolveHost, request } = createHarness({ addresses });

    await expect(entry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/guide` })))
      .rejects.toThrow('web.fetch_text destination is not allowed');
    expect(resolveHost).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'cross-origin redirect',
      responses: [response({ status: 302, location: 'https://other.example.invalid/final' })],
      message: 'web.fetch_text redirect is not allowed',
    },
    {
      label: 'missing redirect location',
      responses: [response({ status: 302 })],
      message: 'web.fetch_text redirect is not allowed',
    },
    {
      label: 'redirect limit',
      responses: [
        response({ status: 302, location: '/one' }),
        response({ status: 302, location: '/two' }),
        response({ status: 302, location: '/three' }),
        response({ status: 302, location: '/four' }),
      ],
      message: 'web.fetch_text redirect limit exceeded',
    },
  ])('rejects $label with a fixed failure', async ({ responses, message }) => {
    const request = vi.fn<WebFetchTransport>();
    for (const item of responses) {
      request.mockResolvedValueOnce(item);
    }
    const entry = createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN],
      resolveHost: vi.fn<WebFetchResolver>().mockResolvedValue([PUBLIC_ADDRESS]),
      request,
    });

    await expect(entry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/start` })))
      .rejects.toThrow(message);
  });

  it.each([
    {
      label: 'non-success status',
      response: response({ status: 404, statusText: 'secret diagnostic' }),
      message: 'web.fetch_text request failed',
    },
    {
      label: 'binary content type',
      response: response({ contentType: 'application/octet-stream' }),
      message: 'web.fetch_text response is not text',
    },
    {
      label: 'non-UTF-8 charset',
      response: response({ contentType: 'text/plain; charset=iso-8859-1' }),
      message: 'web.fetch_text response is not UTF-8',
    },
    {
      label: 'compressed response',
      response: response({ contentEncoding: 'gzip' }),
      message: 'web.fetch_text response encoding is not allowed',
    },
    {
      label: 'oversized declared body',
      response: response({ contentLength: '2049' }),
      message: 'web.fetch_text response is too large',
    },
    {
      label: 'oversized streamed body',
      response: response({ body: ['a'.repeat(2048), 'b'] }),
      message: 'web.fetch_text response is too large',
    },
    {
      label: 'invalid UTF-8 body',
      response: response({ bodyBytes: [Uint8Array.from([0xc3, 0x28])] }),
      message: 'web.fetch_text response is not UTF-8',
    },
    {
      label: 'control content',
      response: response({ body: ['visible\u0000hidden'] }),
      message: 'web.fetch_text response is not text',
    },
  ])('rejects $label without exposing remote diagnostics', async ({ response: item, message }) => {
    const { entry, dispose } = createHarness({ response: item });

    await expect(entry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/guide` })))
      .rejects.toThrow(message);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('maps resolver and transport failures to fixed path-free errors without retry', async () => {
    const resolveFailure = new Error('getaddrinfo secret.internal.local');
    const resolver = vi.fn<WebFetchResolver>().mockRejectedValue(resolveFailure);
    const request = vi.fn<WebFetchTransport>();
    const resolverEntry = createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN],
      resolveHost: resolver,
      request,
    });

    await expect(resolverEntry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/guide` })))
      .rejects.toThrow('web.fetch_text is unavailable');
    expect(resolver).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();

    const transport = vi.fn<WebFetchTransport>()
      .mockRejectedValue(new Error('connect ECONNREFUSED 93.184.216.34'));
    const transportEntry = createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN],
      resolveHost: vi.fn<WebFetchResolver>().mockResolvedValue([PUBLIC_ADDRESS]),
      request: transport,
    });

    await expect(transportEntry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/guide` })))
      .rejects.toThrow('web.fetch_text is unavailable');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects redaction expansion beyond the declared output envelope', async () => {
    const source = '12345\n'.repeat(341);
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(2048);
    const { entry } = createHarness({
      response: response({ body: [source] }),
    });

    await expect(entry.handler(toolRequest({ url: `${ALLOWED_ORIGIN}/guide` })))
      .rejects.toThrow('web.fetch_text response is too large');
  });

  it('honors abort before resolution and during body streaming', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const before = createHarness();

    await expect(before.entry.handler(toolRequest(
      { url: `${ALLOWED_ORIGIN}/guide` },
      { signal: preAborted.signal },
    ))).rejects.toThrow('web.fetch_text aborted');
    expect(before.resolveHost).not.toHaveBeenCalled();

    const during = new AbortController();
    const dispose = vi.fn();
    const streamedResponse = response({ dispose });
    streamedResponse.body = (async function* body(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('first');
      during.abort();
      yield encoder.encode('second');
    }());
    const entry = createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN],
      resolveHost: vi.fn<WebFetchResolver>().mockResolvedValue([PUBLIC_ADDRESS]),
      request: vi.fn<WebFetchTransport>().mockResolvedValue(streamedResponse),
    });

    await expect(entry.handler(toolRequest(
      { url: `${ALLOWED_ORIGIN}/guide` },
      { signal: during.signal },
    ))).rejects.toThrow('web.fetch_text aborted');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects invalid constructor origins without resolver or transport access', () => {
    const resolveHost = vi.fn<WebFetchResolver>();
    const request = vi.fn<WebFetchTransport>();

    expect(() => createWebFetchTextTool({
      allowedOrigins: ['http://docs.example.invalid'],
      resolveHost,
      request,
    })).toThrow('web.fetch_text configuration is invalid');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  addresses?: WebFetchAddress[];
  response?: WebFetchTransportResponse;
} = {}): {
  entry: ReturnType<typeof createWebFetchTextTool>;
  resolveHost: ReturnType<typeof vi.fn<WebFetchResolver>>;
  request: ReturnType<typeof vi.fn<WebFetchTransport>>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const resolveHost = vi.fn<WebFetchResolver>()
    .mockResolvedValue(options.addresses ?? [PUBLIC_ADDRESS]);
  const dispose = (options.response?.dispose ?? vi.fn()) as ReturnType<typeof vi.fn>;
  const request = vi.fn<WebFetchTransport>()
    .mockResolvedValue(options.response ?? response({ dispose }));

  return {
    entry: createWebFetchTextTool({
      allowedOrigins: [ALLOWED_ORIGIN],
      resolveHost,
      request,
    }),
    resolveHost,
    request,
    dispose,
  };
}

function response(options: {
  status?: number;
  statusText?: string;
  location?: string;
  contentType?: string;
  contentLength?: string;
  contentEncoding?: string;
  body?: string[];
  bodyBytes?: Uint8Array[];
  dispose?: () => void;
} = {}): WebFetchTransportResponse {
  const bodyBytes = options.bodyBytes
    ?? (options.body ?? ['ok']).map((value) => encoder.encode(value));

  return {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: {
      location: options.location,
      contentType: options.contentType ?? 'text/plain; charset=utf-8',
      contentLength: options.contentLength,
      contentEncoding: options.contentEncoding,
    },
    body: (async function* body(): AsyncGenerator<Uint8Array> {
      for (const value of bodyBytes) {
        yield value;
      }
    }()),
    dispose: options.dispose ?? vi.fn(),
  };
}

function toolRequest(
  input: unknown,
  overrides: Partial<ToolHandlerRequest> = {},
): ToolHandlerRequest {
  return {
    toolCallId: 'tc-web-fetch-text',
    turnId: 'turn-web-fetch-text',
    toolName: 'web.fetch_text',
    signal: new AbortController().signal,
    evaluatorDecisionId: 'eval-web-fetch-text',
    sourceEventIds: ['raw-web-fetch-text'],
    input,
    actor: {
      actorClass: 'owner',
      canonicalUserId: 'owner-web-fetch-text',
    },
    context: 'private_chat',
    ...overrides,
  };
}
