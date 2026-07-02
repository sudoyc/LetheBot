/**
 * OneBot Runtime Deployment Script
 *
 * Automates deployment of LetheBot with SnowLuma / OneBot integration.
 * Supports Docker, systemd, and PM2 deployment modes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  loadNapCatConfig,
  ConfigValidationError,
  type NapCatConfig,
} from '../config/index.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/**
 * Deployment mode
 */
export type DeploymentMode = 'docker' | 'systemd' | 'pm2' | 'configure';

/**
 * Deployment options
 */
export interface DeploymentOptions {
  mode: DeploymentMode;
  configPath?: string;
  outputDir?: string;
  healthCheck?: boolean;
  verifyNapCat?: boolean;
  healthCheckTimeout?: number;
}

/**
 * Deployment result details
 */
export interface DeploymentDetails {
  configPath: string;
  serverUrl: string;
  oneBotUrl: string;
  napCatUrl: string;
  healthCheckPassed?: boolean;
}

/**
 * Deployment result
 */
export interface DeploymentResult {
  success: boolean;
  message: string;
  details?: DeploymentDetails;
  error?: Error;
}

/**
 * NapCat connection error
 */
export class NapCatConnectionError extends Error {
  constructor(
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'NapCatConnectionError';
  }
}

/**
 * Health check timeout error
 */
export class HealthCheckTimeoutError extends Error {
  constructor(
    message: string,
    public readonly lastError?: string,
  ) {
    super(message);
    this.name = 'HealthCheckTimeoutError';
  }
}

/**
 * Port conflict error
 */
export class PortConflictError extends Error {
  constructor(
    message: string,
    public readonly port: number,
  ) {
    super(message);
    this.name = 'PortConflictError';
  }
}

/**
 * Verify OneBot HTTP connection.
 */
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
      console.error(`OneBot HTTP API returned ${response.status}: ${response.statusText}`);
      return false;
    }

    const result = (await response.json()) as StatusResponse;

    if (result.status === 'ok' || result.retcode === 0) {
      const nickname = typeof result.data?.nickname === 'string' ? result.data.nickname : 'Unknown';
      console.log(`✓ OneBot HTTP connection verified: ${nickname}`);
      return true;
    }

    const message = typeof result.message === 'string' ? result.message : 'Unknown error';
    console.error(`OneBot HTTP API error: ${message}`);
    return false;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        console.error('OneBot HTTP connection timeout (5s)');
      } else {
        console.error(`OneBot HTTP connection failed: ${error.message}`);
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
      console.error(`OneBot WebSocket connection failed: ${error instanceof Error ? error.message : String(error)}`);
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
          console.log(`✓ OneBot WebSocket connection verified: ${nickname}`);
          cleanup(true);
          return;
        }

        const message = typeof parsed.message === 'string' ? parsed.message : 'Unknown error';
        console.error(`OneBot WebSocket API error: ${message}`);
        cleanup(false);
      } catch (error) {
        console.error(`OneBot WebSocket parse error: ${error instanceof Error ? error.message : String(error)}`);
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

/**
 * Generate .env configuration file
 */
export async function generateNapCatConfig(outputPath: string): Promise<void> {
  const examplePath = join(__dirname, '../../.env.example');

  if (!existsSync(examplePath)) {
    throw new Error(`.env.example not found at ${examplePath}`);
  }

  const template = readFileSync(examplePath, 'utf-8');

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, template, 'utf-8');
  console.log(`✓ Configuration template written to ${outputPath}`);
  console.log('  Please edit the file and set required values:');
  console.log('  - ONEBOT_TRANSPORT: ws or http (default: ws)');
  console.log('  - ONEBOT_WS_URL: SnowLuma OneBot WebSocket URL');
  console.log('  - ONEBOT_HTTP_URL: OneBot HTTP API URL');
  console.log('  - ONEBOT_TOKEN: Optional authentication token');
  console.log('  - LETHEBOT_BOT_QQ_ID: Bot QQ id used for exact @ mention detection');
  console.log('  - LETHEBOT_PORT: HTTP server port (default: 6700)');
}

/**
 * Perform health check
 */
async function healthCheck(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return false;
    }

    const result = (await response.json()) as StatusResponse;
    return result.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Wait for service to be healthy
 * @internal Reserved for future use when auto-starting services
 */
export async function waitForHealthy(
  url: string,
  timeout: number = 30000,
): Promise<void> {
  const startTime = Date.now();
  let lastError = '';

  while (Date.now() - startTime < timeout) {
    try {
      const isHealthy = await healthCheck(url);
      if (isHealthy) {
        console.log('✓ Service health check passed');
        return;
      }
      lastError = 'Health check returned non-ok status';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new HealthCheckTimeoutError(
    `Health check timeout after ${timeout}ms`,
    lastError,
  );
}

/**
 * Generate Docker Compose configuration
 */
function generateDockerCompose(config: NapCatConfig): string {
  return `version: '3.8'

services:
  lethebot:
    image: node:22-alpine
    container_name: lethebot
    working_dir: /app
    volumes:
      - ./:/app
      - ./data:/app/data
    ports:
      - "${config.serverPort}:${config.serverPort}"
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}
      - ONEBOT_TRANSPORT=${config.transport}
      - ONEBOT_HTTP_URL=${config.httpUrl}
      - ONEBOT_WS_URL=${config.wsUrl}
      - ONEBOT_TOKEN=${config.token || ''}
      - LETHEBOT_BOT_QQ_ID=${config.botQqId || ''}
      - LETHEBOT_PORT=${config.serverPort}
      - LETHEBOT_HOST=${config.serverHost}
      - LETHEBOT_HEALTH_PATH=${config.healthCheckPath}
      - LETHEBOT_EVENT_PATH=${config.eventPath}
      - LETHEBOT_DB_PATH=/app/data/lethebot.db
    command: sh -c "npm install -g pnpm && pnpm install && pnpm build && pnpm start"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:${config.serverPort}/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
`;
}

/**
 * Generate systemd service file
 */
function generateSystemdService(config: NapCatConfig, workDir: string): string {
  return `[Unit]
Description=LetheBot - QQ Bot with Memory
After=network.target

[Service]
Type=simple
User=${process.env.USER || 'lethebot'}
WorkingDirectory=${workDir}
Environment="NODE_ENV=production"
Environment="LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}"
Environment="ONEBOT_TRANSPORT=${config.transport}"
Environment="ONEBOT_HTTP_URL=${config.httpUrl}"
Environment="ONEBOT_WS_URL=${config.wsUrl}"
Environment="ONEBOT_TOKEN=${config.token || ''}"
Environment="LETHEBOT_BOT_QQ_ID=${config.botQqId || ''}"
Environment="LETHEBOT_PORT=${config.serverPort}"
Environment="LETHEBOT_HOST=${config.serverHost}"
Environment="LETHEBOT_HEALTH_PATH=${config.healthCheckPath}"
Environment="LETHEBOT_EVENT_PATH=${config.eventPath}"
Environment="LETHEBOT_DB_PATH=${workDir}/data/lethebot.db"
ExecStart=${process.execPath} ${workDir}/dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate PM2 ecosystem configuration
 */
function generatePM2Ecosystem(config: NapCatConfig, workDir: string): string {
  return `module.exports = {
  apps: [{
    name: 'lethebot',
    script: '${workDir}/dist/index.js',
    cwd: '${workDir}',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: '${process.env.LOG_LEVEL || 'info'}',
      ONEBOT_TRANSPORT: '${config.transport}',
      ONEBOT_HTTP_URL: '${config.httpUrl}',
      ONEBOT_WS_URL: '${config.wsUrl}',
      ONEBOT_TOKEN: '${config.token || ''}',
      LETHEBOT_BOT_QQ_ID: '${config.botQqId || ''}',
      LETHEBOT_PORT: '${config.serverPort}',
      LETHEBOT_HOST: '${config.serverHost}',
      LETHEBOT_HEALTH_PATH: '${config.healthCheckPath}',
      LETHEBOT_EVENT_PATH: '${config.eventPath}',
      LETHEBOT_DB_PATH: '${workDir}/data/lethebot.db'
    },
    error_file: '${workDir}/logs/pm2-error.log',
    out_file: '${workDir}/logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
`;
}

/**
 * Deploy LetheBot
 */
export async function deployLetheBot(
  options: DeploymentOptions,
): Promise<DeploymentResult> {
  const {
    mode,
    configPath = '.env',
    outputDir = process.cwd(),
    healthCheck: enableHealthCheck = true,
    verifyNapCat = false,
  } = options;

  try {
    // Special mode: just generate config
    if (mode === 'configure') {
      const outputPath = configPath || '.env';
      await generateNapCatConfig(outputPath);
      return {
        success: true,
        message: 'Configuration template generated',
        details: {
          configPath: outputPath,
          serverUrl: 'http://localhost:6700',
          oneBotUrl: 'ws://localhost:3001/',
          napCatUrl: 'http://localhost:3000',
        },
      };
    }

    // Load and validate configuration
    console.log('Loading configuration...');
    let config: NapCatConfig;
    try {
      config = loadNapCatConfig();
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        console.error('\n❌ Configuration validation failed:');
        for (const issue of error.issues) {
          console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
        }
        console.error('\nPlease fix the configuration and try again.');
        return {
          success: false,
          message: 'Configuration validation failed',
          error: error as Error,
        };
      }
      throw error;
    }

    console.log('✓ Configuration loaded');

    // Verify OneBot runtime connection if requested
    if (verifyNapCat) {
      console.log('Verifying OneBot runtime connection...');
      const isConnected = await verifyOneBotConnection(config);

      if (!isConnected) {
        const oneBotUrl = config.transport === 'ws' ? config.wsUrl : config.httpUrl;
        const error = new NapCatConnectionError(
          'Failed to connect to OneBot runtime',
          oneBotUrl,
        );
        console.error('\n❌ OneBot runtime connection failed');
        console.error('  Please check:');
        console.error(`  - Is SnowLuma / OneBot running at ${oneBotUrl}?`);
        console.error('  - Is ONEBOT_TRANSPORT / ONEBOT_WS_URL / ONEBOT_HTTP_URL correct?');
        console.error('  - Is the network reachable?');
        console.error(`  - HTTP smoke: curl -X POST ${config.httpUrl}/get_login_info`);
        return {
          success: false,
          message: 'OneBot runtime connection verification failed',
          error,
        };
      }
    }

    const workDir = process.cwd();
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const serverUrl = `http://${config.serverHost === '0.0.0.0' ? 'localhost' : config.serverHost}:${config.serverPort}`;

    // Deploy based on mode
    if (mode === 'docker') {
      console.log('Generating Docker Compose configuration...');
      const dockerCompose = generateDockerCompose(config);
      const composePath = join(outputDir, 'docker-compose.yml');
      writeFileSync(composePath, dockerCompose, 'utf-8');
      console.log(`✓ docker-compose.yml written to ${composePath}`);
      console.log('\nTo start the service, run:');
      console.log('  docker-compose up -d');
    } else if (mode === 'systemd') {
      console.log('Generating systemd service file...');
      const serviceContent = generateSystemdService(config, workDir);
      const servicePath = join(outputDir, 'lethebot.service');
      writeFileSync(servicePath, serviceContent, 'utf-8');
      console.log(`✓ lethebot.service written to ${servicePath}`);
      console.log('\nTo install and start the service, run:');
      console.log(`  sudo cp ${servicePath} /etc/systemd/system/`);
      console.log('  sudo systemctl daemon-reload');
      console.log('  sudo systemctl enable lethebot');
      console.log('  sudo systemctl start lethebot');
      console.log('\nTo check status:');
      console.log('  sudo systemctl status lethebot');
      console.log('  sudo journalctl -u lethebot -f');
    } else if (mode === 'pm2') {
      console.log('Generating PM2 ecosystem configuration...');
      const ecosystemContent = generatePM2Ecosystem(config, workDir);
      const ecosystemPath = join(outputDir, 'ecosystem.config.js');
      writeFileSync(ecosystemPath, ecosystemContent, 'utf-8');
      console.log(`✓ ecosystem.config.js written to ${ecosystemPath}`);
      console.log('\nTo start the service, run:');
      console.log(`  pm2 start ${ecosystemPath}`);
      console.log('\nTo manage the service:');
      console.log('  pm2 status');
      console.log('  pm2 logs lethebot');
      console.log('  pm2 restart lethebot');
      console.log('  pm2 stop lethebot');
    } else {
      throw new Error(`Unsupported deployment mode: ${mode}`);
    }

    // Perform health check if enabled
    let healthCheckPassed: boolean | undefined;
    if (enableHealthCheck) {
      console.log('\nNote: Manual service start required.');
      console.log('Health check skipped (service not auto-started).');
    }

    return {
      success: true,
      message: `Deployment configuration generated for ${mode}`,
      details: {
        configPath,
        serverUrl,
        oneBotUrl: config.transport === 'ws' ? config.wsUrl : config.httpUrl,
        napCatUrl: config.httpUrl,
        healthCheckPassed,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      error: error as Error,
    };
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith('--mode='));
  const mode = (modeArg?.split('=')[1] ?? 'configure') as DeploymentMode;

  const verifyArg = args.includes('--verify-napcat') || args.includes('--verify-onebot');
  const noHealthCheck = args.includes('--no-health-check');

  console.log('╔════════════════════════════════════════╗');
  console.log('║  LetheBot OneBot Deployment Tool      ║');
  console.log('╚════════════════════════════════════════╝\n');

  const result = await deployLetheBot({
    mode,
    verifyNapCat: verifyArg,
    healthCheck: !noHealthCheck,
  });

  console.log('\n' + '═'.repeat(42));
  if (result.success) {
    console.log(`✓ ${result.message}`);
    if (result.details) {
      console.log('\nDetails:');
      console.log(`  Config: ${result.details.configPath}`);
      console.log(`  Server: ${result.details.serverUrl}`);
      console.log(`  OneBot: ${result.details.oneBotUrl}`);
      if (result.details.healthCheckPassed !== undefined) {
        console.log(`  Health: ${result.details.healthCheckPassed ? '✓' : '✗'}`);
      }
    }
  } else {
    console.log(`✗ ${result.message}`);
    if (result.error) {
      console.error(`\nError: ${result.error.message}`);
    }
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
