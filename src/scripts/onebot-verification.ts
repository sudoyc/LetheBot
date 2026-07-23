/**
 * Production-runtime-safe OneBot connectivity verification.
 */

import type { NapCatConfig } from '../config/index.js';
import { redactSecretsInText } from '../memory/secret-scan.js';

interface StatusResponse {
  status?: unknown;
  retcode?: unknown;
  message?: unknown;
  echo?: unknown;
  data?: {
    nickname?: unknown;
  };
}

interface VerifyWebSocketEvent {
  data?: unknown;
}

interface VerifyWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    handler: (event: VerifyWebSocketEvent) => void,
  ): void;
}

function redactForDisplay(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function display(value: unknown): string {
  return redactForDisplay(value instanceof Error ? value.message : String(value));
}

export async function verifyNapCatConnection(
  httpUrl: string,
  token?: string,
): Promise<boolean> {
  try {
    const url = `${httpUrl}/get_login_info`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`OneBot HTTP API returned ${response.status}: ${redactForDisplay(response.statusText)}`);
      return false;
    }

    const result = (await response.json()) as StatusResponse;

    if (result.status === 'ok' || result.retcode === 0) {
      const nickname = typeof result.data?.nickname === 'string' ? result.data.nickname : 'Unknown';
      console.log(`✓ OneBot HTTP connection verified: ${redactForDisplay(nickname)}`);
      return true;
    }

    const message = typeof result.message === 'string' ? result.message : 'Unknown error';
    console.error(`OneBot HTTP API error: ${redactForDisplay(message)}`);
    return false;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        console.error('OneBot HTTP connection timeout (5s)');
      } else {
        console.error(`OneBot HTTP connection failed: ${redactForDisplay(error.message)}`);
      }
    }
    return false;
  }
}

export async function verifyOneBotConnection(config: NapCatConfig): Promise<boolean> {
  if (config.transport === 'ws') {
    return verifyOneBotWebSocketConnection(config.wsUrl, config.token);
  }
  return verifyNapCatConnection(config.httpUrl, config.token);
}

export function verifyOneBotWebSocketConnection(
  wsUrl: string,
  token?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const echo = `verify-onebot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const timeout = setTimeout(() => {
      console.error('OneBot WebSocket connection timeout (5s)');
      cleanup(false);
    }, 5000);

    let settled = false;
    let socket: VerifyWebSocketLike | null = null;

    const cleanup = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        socket?.close(1000, 'verify complete');
      } catch {
        // Ignore close errors during verification cleanup.
      }
      resolve(result);
    };

    try {
      socket = new WebSocket(buildWebSocketUrl(wsUrl, token)) as unknown as VerifyWebSocketLike;
    } catch (error) {
      clearTimeout(timeout);
      console.error(`OneBot WebSocket connection failed: ${display(error)}`);
      resolve(false);
      return;
    }

    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({ action: 'get_login_info', params: {}, echo }));
    });
    socket.addEventListener('message', (event) => {
      const text = websocketPayloadToString(event.data);
      if (!text) {
        return;
      }

      try {
        const parsed = JSON.parse(text) as StatusResponse;
        if (parsed.echo !== echo) {
          return;
        }
        if (parsed.status === 'ok' || parsed.retcode === 0) {
          const nickname = typeof parsed.data?.nickname === 'string' ? parsed.data.nickname : 'Unknown';
          console.log(`✓ OneBot WebSocket connection verified: ${redactForDisplay(nickname)}`);
          cleanup(true);
          return;
        }

        const message = typeof parsed.message === 'string' ? parsed.message : 'Unknown error';
        console.error(`OneBot WebSocket API error: ${redactForDisplay(message)}`);
        cleanup(false);
      } catch (error) {
        console.error(`OneBot WebSocket parse error: ${display(error)}`);
        cleanup(false);
      }
    });
    socket.addEventListener('error', () => {
      console.error('OneBot WebSocket connection failed');
      cleanup(false);
    });
    socket.addEventListener('close', () => {
      cleanup(false);
    });
  });
}

function buildWebSocketUrl(wsUrl: string, token?: string): string {
  const url = new URL(wsUrl);
  if (token) {
    url.searchParams.set('access_token', token);
  }
  return url.toString();
}

function websocketPayloadToString(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8');
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8');
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  }
  return '';
}
