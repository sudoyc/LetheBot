/**
 * Network Request Tool Handler Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateUrl,
  isAllowedDomain,
  NetworkRequestHandlerImpl,
  type NetworkRequestInput,
} from '../../../../src/tools/handlers/network-request';

describe('validateUrl', () => {
  it('should accept valid HTTP URLs', () => {
    expect(validateUrl('http://example.com')).toBe(true);
    expect(validateUrl('http://api.example.com/v1/data')).toBe(true);
  });

  it('should accept valid HTTPS URLs', () => {
    expect(validateUrl('https://example.com')).toBe(true);
    expect(validateUrl('https://api.example.com:8443/path')).toBe(true);
  });

  it('should reject non-HTTP protocols', () => {
    expect(validateUrl('file:///etc/passwd')).toBe(false);
    expect(validateUrl('ftp://example.com')).toBe(false);
    expect(validateUrl('javascript:alert(1)')).toBe(false);
    expect(validateUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('should reject localhost addresses', () => {
    expect(validateUrl('http://localhost')).toBe(false);
    expect(validateUrl('http://localhost:8080')).toBe(false);
    expect(validateUrl('http://127.0.0.1')).toBe(false);
    expect(validateUrl('http://[::1]')).toBe(false);
    expect(validateUrl('http://0.0.0.0')).toBe(false);
  });

  it('should reject private network addresses', () => {
    // 10.0.0.0/8
    expect(validateUrl('http://10.0.0.1')).toBe(false);
    expect(validateUrl('http://10.255.255.255')).toBe(false);

    // 172.16.0.0/12
    expect(validateUrl('http://172.16.0.1')).toBe(false);
    expect(validateUrl('http://172.31.255.255')).toBe(false);

    // 192.168.0.0/16
    expect(validateUrl('http://192.168.1.1')).toBe(false);
    expect(validateUrl('http://192.168.255.255')).toBe(false);

    // 169.254.0.0/16 (link-local)
    expect(validateUrl('http://169.254.169.254')).toBe(false);
  });

  it('should accept public IP addresses', () => {
    expect(validateUrl('http://8.8.8.8')).toBe(true);
    expect(validateUrl('http://1.1.1.1')).toBe(true);
    expect(validateUrl('http://172.15.0.1')).toBe(true); // not in private range
    expect(validateUrl('http://172.32.0.1')).toBe(true); // not in private range
  });

  it('should reject invalid URLs', () => {
    expect(validateUrl('not a url')).toBe(false);
    expect(validateUrl('')).toBe(false);
    expect(validateUrl('http://')).toBe(false);
  });
});

describe('isAllowedDomain', () => {
  it('should reject all domains when allowlist is empty', () => {
    expect(isAllowedDomain('https://example.com', [])).toBe(false);
    expect(isAllowedDomain('https://api.example.com', [])).toBe(false);
  });

  it('should match exact domain names', () => {
    const allowlist = ['example.com', 'api.example.org'];

    expect(isAllowedDomain('https://example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://example.com/path', allowlist)).toBe(true);
    expect(isAllowedDomain('https://api.example.org', allowlist)).toBe(true);
  });

  it('should reject non-matching domains', () => {
    const allowlist = ['example.com'];

    expect(isAllowedDomain('https://evil.com', allowlist)).toBe(false);
    expect(isAllowedDomain('https://examplecom.evil.com', allowlist)).toBe(false);
  });

  it('should support wildcard subdomains', () => {
    const allowlist = ['*.example.com'];

    expect(isAllowedDomain('https://api.example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://www.example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://deep.nested.example.com', allowlist)).toBe(true);
  });

  it('should match base domain with wildcard', () => {
    const allowlist = ['*.example.com'];

    // Wildcard should also match the base domain
    expect(isAllowedDomain('https://example.com', allowlist)).toBe(true);
  });

  it('should not allow wildcard to match other domains', () => {
    const allowlist = ['*.example.com'];

    expect(isAllowedDomain('https://example.org', allowlist)).toBe(false);
    expect(isAllowedDomain('https://notexample.com', allowlist)).toBe(false);
    expect(isAllowedDomain('https://example.com.evil.com', allowlist)).toBe(false);
  });

  it('should be case-insensitive', () => {
    const allowlist = ['Example.COM', '*.API.example.ORG'];

    expect(isAllowedDomain('https://example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://EXAMPLE.COM', allowlist)).toBe(true);
    expect(isAllowedDomain('https://v1.api.example.org', allowlist)).toBe(true);
    expect(isAllowedDomain('https://V1.API.EXAMPLE.ORG', allowlist)).toBe(true);
  });

  it('should handle mixed exact and wildcard rules', () => {
    const allowlist = ['example.com', '*.api.example.com', 'specific.other.com'];

    expect(isAllowedDomain('https://example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://v1.api.example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://api.example.com', allowlist)).toBe(true);
    expect(isAllowedDomain('https://specific.other.com', allowlist)).toBe(true);

    expect(isAllowedDomain('https://www.example.com', allowlist)).toBe(false);
    expect(isAllowedDomain('https://other.com', allowlist)).toBe(false);
  });
});

describe('NetworkRequestHandlerImpl', () => {
  let handler: NetworkRequestHandlerImpl;

  beforeEach(() => {
    handler = new NetworkRequestHandlerImpl(['example.com', '*.api.test.com']);
  });

  it('should reject invalid URLs', async () => {
    const input: NetworkRequestInput = {
      url: 'not-a-valid-url',
    };

    const result = await handler.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should reject localhost URLs', async () => {
    const input: NetworkRequestInput = {
      url: 'http://localhost:8080/api',
    };

    const result = await handler.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL or forbidden protocol/host');
  });

  it('should reject private network URLs', async () => {
    const input: NetworkRequestInput = {
      url: 'http://192.168.1.1/admin',
    };

    const result = await handler.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL or forbidden protocol/host');
  });

  it('should reject non-allowlisted domains', async () => {
    const input: NetworkRequestInput = {
      url: 'https://evil.com/steal-data',
    };

    const result = await handler.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Domain not in allowlist');
  });

  it('should accept allowlisted domains', async () => {
    // Mock fetch
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"result":"success"}',
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const input: NetworkRequestInput = {
      url: 'https://example.com/api/data',
    };

    const result = await handler.execute(input);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.statusText).toBe('OK');
    expect(result.body).toBe('{"result":"success"}');
    expect(result.headers).toHaveProperty('content-type', 'application/json');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should accept wildcard subdomain matches', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'ok',
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const input: NetworkRequestInput = {
      url: 'https://v1.api.test.com/endpoint',
    };

    const result = await handler.execute(input);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  it('should handle GET requests by default', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'response',
    });
    global.fetch = mockFetch;

    await handler.execute({ url: 'https://example.com' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        method: 'GET',
      })
    );
  });

  it('should support custom HTTP methods', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: new Headers(),
      text: async () => '',
    });
    global.fetch = mockFetch;

    await handler.execute({
      url: 'https://example.com/resource',
      method: 'POST',
      body: { name: 'test' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/resource',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      })
    );
  });

  it('should add Content-Type header for JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '',
    });
    global.fetch = mockFetch;

    await handler.execute({
      url: 'https://example.com',
      method: 'POST',
      body: { key: 'value' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('should handle string body without modifying Content-Type', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '',
    });
    global.fetch = mockFetch;

    await handler.execute({
      url: 'https://example.com',
      method: 'POST',
      body: 'raw string data',
      headers: { 'Content-Type': 'text/plain' },
    });

    const call = mockFetch.mock.calls[0][1] as RequestInit;
    expect(call.body).toBe('raw string data');
    expect(call.headers).toHaveProperty('Content-Type', 'text/plain');
  });

  it('should include custom headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '',
    });
    global.fetch = mockFetch;

    await handler.execute({
      url: 'https://example.com',
      headers: {
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'custom-value',
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value',
          'User-Agent': 'LetheBot/1.0',
        }),
      })
    );
  });

  it('should apply timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '',
    });
    global.fetch = mockFetch;

    await handler.execute({
      url: 'https://example.com',
      timeout: 10000,
    });

    const call = mockFetch.mock.calls[0][1] as RequestInit;
    expect(call.signal).toBeDefined();
  });

  it('should handle timeout errors', async () => {
    const timeoutError = new Error('Timeout');
    timeoutError.name = 'TimeoutError';
    global.fetch = vi.fn().mockRejectedValue(timeoutError);

    const result = await handler.execute({
      url: 'https://example.com',
      timeout: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request timeout');
  });

  it('should handle network errors', async () => {
    const networkError = new Error('Network failure');
    global.fetch = vi.fn().mockRejectedValue(networkError);

    const result = await handler.execute({
      url: 'https://example.com',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network failure');
  });

  it('should handle HTTP error responses', async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: async () => 'Page not found',
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await handler.execute({
      url: 'https://example.com/missing',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');
    expect(result.body).toBe('Page not found');
  });

  it('should truncate large responses', async () => {
    const largeBody = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => largeBody,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await handler.execute({
      url: 'https://example.com',
    });

    expect(result.success).toBe(true);
    expect(result.body).toHaveLength(1048576 + '\n[truncated]'.length);
    expect(result.body).toContain('[truncated]');
  });

  it('should not truncate responses under limit', async () => {
    const normalBody = 'x'.repeat(1000); // 1KB
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => normalBody,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await handler.execute({
      url: 'https://example.com',
    });

    expect(result.success).toBe(true);
    expect(result.body).toBe(normalBody);
    expect(result.body).not.toContain('[truncated]');
  });

  it('should convert response headers to object', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'application/json',
        'x-rate-limit': '100',
        'cache-control': 'no-cache',
      }),
      text: async () => '{}',
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await handler.execute({
      url: 'https://example.com',
    });

    expect(result.headers).toEqual({
      'content-type': 'application/json',
      'x-rate-limit': '100',
      'cache-control': 'no-cache',
    });
  });

  it('should measure execution time', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'delayed';
      },
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await handler.execute({
      url: 'https://example.com',
    });

    expect(result.executionTimeMs).toBeGreaterThan(0);
  });
});
