/**
 * Network Request Tool Handler
 *
 * HTTP/HTTPS 网络请求工具实现
 */

import { redactSecretsInText } from '../../memory/secret-scan';
import type { ToolRegistryEntry } from '../../types/tool';

/**
 * HTTP 请求方法
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * 网络请求工具输入（Pi Schema）
 */
export interface NetworkRequestInput {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string | object;
  timeout?: number;
}

/**
 * 网络请求工具输出（Pi Schema）
 */
export interface NetworkRequestOutput {
  success: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  executionTimeMs: number;
}

/**
 * Pi Schema 定义
 */
export const networkRequestPiSchema = {
  input: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'Target URL (must be HTTP or HTTPS)',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        default: 'GET',
        description: 'HTTP method',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Request headers (optional)',
      },
      body: {
        oneOf: [
          { type: 'string' },
          { type: 'object' }
        ],
        description: 'Request body (string or JSON object)',
      },
      timeout: {
        type: 'number',
        minimum: 100,
        maximum: 30000,
        default: 5000,
        description: 'Request timeout in milliseconds',
      },
    },
    required: ['url'],
  },
  output: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      status: { type: 'number' },
      statusText: { type: 'string' },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
      body: { type: 'string' },
      error: { type: 'string' },
      executionTimeMs: { type: 'number' },
    },
    required: ['success', 'executionTimeMs'],
  },
};

/**
 * 网络请求处理器接口
 */
export interface NetworkRequestHandler {
  execute(input: NetworkRequestInput): Promise<NetworkRequestOutput>;
  validateUrl(url: string): boolean;
  isAllowedDomain(url: string, allowedDomains: string[]): boolean;
}

/**
 * URL 验证
 *
 * 仅允许 HTTP/HTTPS 协议，禁止本地地址和内网地址
 */
export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // 仅允许 HTTP/HTTPS 协议
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // 禁止本地地址和内网地址
    const hostname = parsed.hostname.toLowerCase();

    // Check string patterns (with and without brackets for IPv6)
    const localHosts = [
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      '0.0.0.0',
    ];

    if (localHosts.includes(hostname)) {
      return false;
    }

    // Check regex patterns for private networks
    const privateNetworks = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
    ];

    for (const pattern of privateNetworks) {
      if (pattern.test(hostname)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 域名白名单检查
 *
 * 支持精确匹配和通配符子域名（*.example.com）
 */
export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) {
    // 如果未配置白名单，拒绝所有请求
    return false;
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  for (const allowed of allowedDomains) {
    const allowedLower = allowed.toLowerCase();

    // 精确匹配
    if (hostname === allowedLower) {
      return true;
    }

    // 子域名匹配（允许 *.example.com）
    if (allowedLower.startsWith('*.')) {
      const baseDomain = allowedLower.slice(2);
      if (hostname === baseDomain || hostname.endsWith('.' + baseDomain)) {
        return true;
      }
    }
  }

  return false;
}

function redactNetworkDiagnosticText(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  if (platformRedacted.includes('[REDACTED:platform_id]') && !redacted.includes('[REDACTED:platform_id]')) {
    return `${redacted} [REDACTED:platform_id]`;
  }
  return redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

/**
 * 网络请求处理器实现
 */
export class NetworkRequestHandlerImpl implements NetworkRequestHandler {
  constructor(private allowedDomains: string[] = []) {}

  validateUrl = validateUrl;
  isAllowedDomain = isAllowedDomain;

  /**
   * 执行网络请求
   */
  async execute(input: NetworkRequestInput): Promise<NetworkRequestOutput> {
    const startTime = Date.now();

    try {
      // 验证 URL
      if (!this.validateUrl(input.url)) {
        return {
          success: false,
          error: 'Invalid URL or forbidden protocol/host',
          executionTimeMs: Date.now() - startTime,
        };
      }

      // 检查域名白名单
      if (!this.isAllowedDomain(input.url, this.allowedDomains)) {
        return {
          success: false,
          error: 'Domain not in allowlist',
          executionTimeMs: Date.now() - startTime,
        };
      }

      // 准备请求选项
      const method = input.method || 'GET';
      const options: RequestInit = {
        method,
        headers: {
          'User-Agent': 'LetheBot/1.0',
          ...input.headers,
        },
        signal: AbortSignal.timeout(input.timeout || 5000),
      };

      // 处理请求体
      if (input.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        if (typeof input.body === 'string') {
          options.body = input.body;
        } else {
          options.body = JSON.stringify(input.body);
          options.headers = {
            ...options.headers,
            'Content-Type': 'application/json',
          };
        }
      }

      // 执行请求
      const response = await fetch(input.url, options);

      // 读取响应体（限制大小）
      const maxBodySize = 1048576; // 1MB
      const bodyText = await response.text();
      const redactedBodyText = redactNetworkDiagnosticText(bodyText);
      const truncated = redactedBodyText.length > maxBodySize
        ? redactedBodyText.slice(0, maxBodySize) + '\n[truncated]'
        : redactedBodyText;

      // 构建响应头字典
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = redactNetworkDiagnosticText(value);
      });

      return {
        success: response.ok,
        status: response.status,
        statusText: redactNetworkDiagnosticText(response.statusText),
        headers,
        body: truncated,
        executionTimeMs: Date.now() - startTime,
      };

    } catch (error: unknown) {
      const err = error as Error;
      const message = err.message || 'Unknown error';
      const redactedMessage = redactNetworkDiagnosticText(message);

      return {
        success: false,
        error: err.name === 'TimeoutError'
          ? 'Request timeout'
          : redactedMessage,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}

/**
 * 工具注册配置
 */
export const networkRequestToolEntry: ToolRegistryEntry = {
  name: 'network_request',
  version: '1.0.0',
  description: 'Makes HTTP/HTTPS requests to external APIs and services',

  capabilities: ['network', 'external_side_effect'],

  permissions: {
    allowedActors: ['owner', 'admin', 'trusted_user'],
    allowedContexts: ['private_chat', 'admin_cli', 'background_worker'],
  },

  evaluatorPolicy: 'required',

  auditLevel: 'redacted_full',

  sandboxPolicy: {
    filesystem: 'none',
    network: 'restricted',
    execution: 'in_process',
    maxRuntimeMs: 30000,
    maxOutputBytes: 1048576, // 1MB
    allowedDomains: [], // 需要在配置时填写
  },

  outputSensitivity: 'secret_possible',

  piSchema: networkRequestPiSchema,

  handler: async (request) => {
    const handler = new NetworkRequestHandlerImpl(
      networkRequestToolEntry.sandboxPolicy.allowedDomains ?? []
    );
    return handler.execute(request.input as NetworkRequestInput);
  },
};

/**
 * 创建网络请求处理器工厂函数
 */
export function createNetworkRequestHandler(allowedDomains: string[]): NetworkRequestHandler {
  return new NetworkRequestHandlerImpl(allowedDomains);
}
