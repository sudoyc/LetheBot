/**
 * OneBot Runtime Deployment Script
 *
 * Automates deployment of LetheBot with SnowLuma / OneBot integration.
 * Supports Docker, systemd, and PM2 deployment modes
 */

import {
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, dirname, isAbsolute, resolve } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { MANAGED_STARTUP_PROTOCOL_VERSION } from '../operations/managed-startup.js';
import {
  loadNapCatConfig,
  ConfigValidationError,
  type NapCatConfig,
} from '../config/index.js';
import {
  verifyNapCatConnection,
  verifyOneBotConnection,
  verifyOneBotWebSocketConnection,
} from './onebot-verification.js';
import { fileURLToPath } from 'node:url';
import { redactSecretsInText } from '../memory/secret-scan.js';

export {
  verifyNapCatConnection,
  verifyOneBotConnection,
  verifyOneBotWebSocketConnection,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

interface StatusResponse {
  status?: unknown;
  retcode?: unknown;
  message?: unknown;
  echo?: unknown;
  data?: {
    nickname?: unknown;
  };
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
  deploymentRoot?: string;
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
 * Generate .env configuration file
 */
export async function generateNapCatConfig(outputPath: string): Promise<void> {
  const examplePath = join(__dirname, '../../.env.example');

  if (!existsSync(examplePath)) {
    throw new Error(`.env.example not found at ${redactForDisplay(examplePath)}`);
  }

  const template = readFileSync(examplePath, 'utf-8');

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, template, 'utf-8');
  console.log(`✓ Configuration template written to ${redactForDisplay(outputPath)}`);
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
  return `services:
  lethebot:
    image: \${LETHEBOT_IMAGE:?Set LETHEBOT_IMAGE to a reviewed version tag or digest}
    container_name: lethebot
    user: "\${LETHEBOT_UID:-1000}:\${LETHEBOT_GID:-1000}"
    volumes:
      - type: bind
        source: ./data/lethebot
        target: /app/data
        bind:
          create_host_path: false
    ports:
      - "127.0.0.1:${config.serverPort}:${config.serverPort}"
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=\${LOG_LEVEL:-info}
      - LETHEBOT_TEST=\${LETHEBOT_TEST:-false}
      - LETHEBOT_BACKGROUND_SUMMARY_ENABLED=\${LETHEBOT_BACKGROUND_SUMMARY_ENABLED:-false}
      - PI_PROVIDER=\${PI_PROVIDER:-mock}
      - PI_MODEL=\${PI_MODEL:-mock}
      - PI_BASE_URL=\${PI_BASE_URL:-}
      - PI_API_KEY=\${PI_API_KEY:-}
      - PI_TURN_TIMEOUT_MS=\${PI_TURN_TIMEOUT_MS:-120000}
      - EVALUATOR_PROVIDER
      - EVALUATOR_MODEL
      - EVALUATOR_BASE_URL
      - EVALUATOR_API_KEY
      - EVALUATOR_TIMEOUT_MS=\${EVALUATOR_TIMEOUT_MS:-30000}
      - EVALUATOR_MAX_RETRIES=\${EVALUATOR_MAX_RETRIES:-1}
      - EVALUATOR_TEMPERATURE=\${EVALUATOR_TEMPERATURE:-0}
      - EVALUATOR_PROMPT_VERSION=\${EVALUATOR_PROMPT_VERSION:-lethebot-governance-v1}
      - ONEBOT_TRANSPORT=\${ONEBOT_TRANSPORT:-${config.transport}}
      - ONEBOT_HTTP_URL=\${ONEBOT_HTTP_URL:?Set ONEBOT_HTTP_URL in .env or shell}
      - ONEBOT_WS_URL=\${ONEBOT_WS_URL:?Set ONEBOT_WS_URL in .env or shell}
      - ONEBOT_TOKEN=\${ONEBOT_TOKEN:-}
      - LETHEBOT_BOT_QQ_ID=\${LETHEBOT_BOT_QQ_ID:-}
      - LETHEBOT_PORT=${config.serverPort}
      - LETHEBOT_HOST=${config.serverHost}
      - LETHEBOT_HEALTH_PATH=${config.healthCheckPath}
      - LETHEBOT_READINESS_PATH=${config.readinessPath}
      - LETHEBOT_METRICS_PATH=${config.metricsPath}
      - LETHEBOT_EVENT_PATH=${config.eventPath}
      - LETHEBOT_DB_PATH=/app/data/lethebot.db
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "node -e \\"fetch('http://127.0.0.1:${config.serverPort}${config.healthCheckPath}').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))\\""]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
`;
}

/**
 * Generate systemd service file
 */
function generateSystemdService(deploymentRoot: string): string {
  const currentDir = join(deploymentRoot, 'current');
  const sharedDir = join(deploymentRoot, 'shared');
  const gatePath = join(sharedDir, 'bin', 'managed-startup.js');
  const entrypointPath = join(currentDir, 'dist/index.js');
  const literal = (value: string): string => JSON.stringify(value);
  if (/[%$\r\n]/.test(process.execPath)) {
    throw new Error('Node executable path contains unsupported systemd expansion characters');
  }

  return `[Unit]
Description=LetheBot - QQ Bot with Memory
After=network.target

[Service]
Type=simple
User=lethebot
WorkingDirectory=${literal(currentDir)}
EnvironmentFile=${literal(join(sharedDir, 'runtime.env'))}
UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT
ExecCondition=+/usr/bin/env ${literal(process.execPath)} ${literal(gatePath)} ${literal('condition')} ${literal(`--root=${deploymentRoot}`)} ${literal(`--entrypoint=${entrypointPath}`)}
ExecStart=${literal('/usr/bin/env')} ${literal('NODE_ENV=production')} ${literal(`LETHEBOT_DB_PATH=${join(sharedDir, 'data/lethebot.db')}`)} ${literal(process.execPath)} ${literal(entrypointPath)}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate PM2 ecosystem configuration
 */
function generatePM2Ecosystem(deploymentRoot: string): string {
  const literal = (value: string): string => JSON.stringify(value);
  const currentDir = join(deploymentRoot, 'current');
  const sharedDir = join(deploymentRoot, 'shared');
  const entrypointPath = join(currentDir, 'dist/index.js');

  return `const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');

const runtimeEnv = parseEnv(readFileSync(${literal(join(sharedDir, 'runtime.env'))}, 'utf8'));
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) {
  delete runtimeEnv[name];
}

module.exports = {
  apps: [{
    name: 'lethebot',
    script: ${literal(join(sharedDir, 'bin/managed-startup.js'))},
    interpreter: ${literal(process.execPath)},
    args: [
      ${literal('launch')},
      ${literal(`--root=${deploymentRoot}`)},
      ${literal(`--entrypoint=${entrypointPath}`)}
    ],
    cwd: ${literal(currentDir)},
    instances: 1,
    autorestart: true,
    stop_exit_codes: [78],
    watch: false,
    max_memory_restart: '1G',
    env: {
      ...runtimeEnv,
      NODE_ENV: 'production',
      LETHEBOT_DB_PATH: ${literal(join(sharedDir, 'data/lethebot.db'))}
    },
    error_file: ${literal(join(sharedDir, 'logs/pm2-error.log'))},
    out_file: ${literal(join(sharedDir, 'logs/pm2-out.log'))},
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
`;
}

function writeManagedStartupAssets(outputDir: string): void {
  const binDir = join(outputDir, 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const sources = [
    {
      input: new URL('../operations/release-artifact.ts', import.meta.url),
      output: join(binDir, 'release-artifact.js'),
    },
    {
      input: new URL('../operations/managed-startup.ts', import.meta.url),
      output: join(binDir, 'managed-startup.js'),
    },
  ];
  const generated = new Map<string, string>();
  for (const source of sources) {
    const compiled = transpileModule(readFileSync(source.input, 'utf8'), {
      compilerOptions: {
        module: ModuleKind.ES2022,
        target: ScriptTarget.ES2022,
        sourceMap: false,
        declaration: false,
      },
      fileName: source.input.pathname,
      reportDiagnostics: true,
    });
    if (compiled.diagnostics && compiled.diagnostics.length > 0) {
      throw new Error('Managed startup asset could not be generated');
    }
    writeManagedStartupAsset(source.output, compiled.outputText, 0o555);
    generated.set(basename(source.output), compiled.outputText);
  }
  const packagePath = join(binDir, 'package.json');
  writeManagedStartupAsset(packagePath, '{"private":true,"type":"module"}\n', 0o444);
  const manifest = {
    schemaVersion: 1,
    protocolVersion: MANAGED_STARTUP_PROTOCOL_VERSION,
    files: {
      'managed-startup.js': createHash('sha256')
        .update(generated.get('managed-startup.js') as string)
        .digest('hex'),
      'release-artifact.js': createHash('sha256')
        .update(generated.get('release-artifact.js') as string)
        .digest('hex'),
    },
  };
  writeManagedStartupAsset(
    join(binDir, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
    0o444,
  );
}

function writeManagedStartupAsset(path: string, content: string, mode: number): void {
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || readFileSync(path, 'utf8') !== content
    ) {
      throw new Error('Existing managed startup asset differs from the reviewed output');
    }
    chmodSync(path, mode);
    return;
  }
  writeFileSync(path, content, { encoding: 'utf8', mode });
  chmodSync(path, mode);
}

/**
 * Deploy LetheBot
 */
export async function deployLetheBot(
  options: DeploymentOptions,
): Promise<DeploymentResult> {
  const {
    mode,
    outputDir = process.cwd(),
    healthCheck: enableHealthCheck = true,
    verifyNapCat = false,
  } = options;
  const configPath = options.configPath
    ?? (mode === 'configure' ? join(outputDir, '.env') : '.env');

  try {
    const managedMode = mode === 'systemd' || mode === 'pm2';
    if (managedMode && !isValidDeploymentRoot(options.deploymentRoot)) {
      throw new Error('Systemd and PM2 deployments require an absolute deployment root');
    }
    if (!managedMode && options.deploymentRoot !== undefined) {
      throw new Error('Deployment root is only supported for systemd and PM2 deployments');
    }
    const deploymentRoot = options.deploymentRoot
      ? resolve(options.deploymentRoot)
      : '';
    if (managedMode && resolve(outputDir) !== join(deploymentRoot, 'shared')) {
      throw new Error('Managed deployment output must be the deployment shared directory');
    }

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
          console.error(`  - ${redactForDisplay(issue.path.join('.'))}: ${redactForDisplay(issue.message)}`);
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
        console.error(`  - Is SnowLuma / OneBot running at ${redactForDisplay(oneBotUrl)}?`);
        console.error('  - Is ONEBOT_TRANSPORT / ONEBOT_WS_URL / ONEBOT_HTTP_URL correct?');
        console.error('  - Is the network reachable?');
        console.error(`  - HTTP smoke: curl -X POST ${redactForDisplay(config.httpUrl)}/get_login_info`);
        return {
          success: false,
          message: 'OneBot runtime connection verification failed',
          error,
        };
      }
    }

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
      console.log(`✓ docker-compose.yml written to ${redactForDisplay(composePath)}`);
      console.log('\nTo start the service, run:');
      console.log('  docker-compose up -d');
    } else if (mode === 'systemd') {
      console.log('Generating systemd service file...');
      writeManagedStartupAssets(outputDir);
      const serviceContent = generateSystemdService(deploymentRoot);
      const servicePath = join(outputDir, 'lethebot.service');
      writeFileSync(servicePath, serviceContent, 'utf-8');
      console.log(`✓ lethebot.service written to ${redactForDisplay(servicePath)}`);
      console.log('\nTo install and start the service, run:');
      console.log(`  sudo cp ${redactForDisplay(servicePath)} /etc/systemd/system/`);
      console.log('  sudo systemctl daemon-reload');
      console.log('  sudo systemctl enable lethebot');
      console.log('  sudo systemctl start lethebot');
      console.log('\nTo check status:');
      console.log('  sudo systemctl status lethebot');
      console.log('  sudo journalctl -u lethebot -f');
    } else if (mode === 'pm2') {
      console.log('Generating PM2 ecosystem configuration...');
      writeManagedStartupAssets(outputDir);
      const ecosystemContent = generatePM2Ecosystem(deploymentRoot);
      const ecosystemPath = join(outputDir, 'ecosystem.config.cjs');
      writeFileSync(ecosystemPath, ecosystemContent, 'utf-8');
      console.log(`✓ ecosystem.config.cjs written to ${redactForDisplay(ecosystemPath)}`);
      console.log('\nTo start the service, run:');
      console.log(`  pm2 start ${redactForDisplay(ecosystemPath)}`);
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
        configPath: deploymentRoot
          ? join(deploymentRoot, 'shared/runtime.env')
          : configPath,
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

export interface DeploymentCliOptions extends DeploymentOptions {
  mode: DeploymentMode;
  verifyNapCat: boolean;
  healthCheck: boolean;
}

const DEPLOYMENT_MODES = new Set<DeploymentMode>(['docker', 'systemd', 'pm2', 'configure']);

export function parseDeploymentCliArgs(args: string[]): DeploymentCliOptions {
  let mode: DeploymentMode = 'configure';
  let outputDir: string | undefined;
  let configPath: string | undefined;
  let deploymentRoot: string | undefined;
  let verifyNapCat = false;
  let healthCheck = true;
  const seenValueOptions = new Set<string>();

  const readValue = (index: number, option: string): { value: string; nextIndex: number } => {
    const argument = args[index];
    if (!argument) {
      throw new Error('Invalid deployment arguments');
    }

    const equalsPrefix = `${option}=`;
    if (argument.startsWith(equalsPrefix)) {
      const value = argument.slice(equalsPrefix.length);
      if (!value) {
        throw new Error('Invalid deployment arguments');
      }
      return { value, nextIndex: index };
    }

    const value = args[index + 1];
    if (argument !== option || !value || value.startsWith('--')) {
      throw new Error('Invalid deployment arguments');
    }
    return { value, nextIndex: index + 1 };
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--verify-napcat' || argument === '--verify-onebot') {
      verifyNapCat = true;
      continue;
    }
    if (argument === '--no-health-check') {
      healthCheck = false;
      continue;
    }

    const option = ['--mode', '--output-dir', '--config-path', '--deployment-root'].find((candidate) => {
      return argument === candidate || argument?.startsWith(`${candidate}=`);
    });
    if (!option || seenValueOptions.has(option)) {
      throw new Error('Invalid deployment arguments');
    }
    seenValueOptions.add(option);

    const parsed = readValue(index, option);
    index = parsed.nextIndex;
    if (option === '--mode') {
      if (!DEPLOYMENT_MODES.has(parsed.value as DeploymentMode)) {
        throw new Error('Invalid deployment arguments');
      }
      mode = parsed.value as DeploymentMode;
    } else if (option === '--output-dir') {
      outputDir = parsed.value;
    } else if (option === '--deployment-root') {
      deploymentRoot = parsed.value;
    } else {
      configPath = parsed.value;
    }
  }

  const managedMode = mode === 'systemd' || mode === 'pm2';
  const resolvedDeploymentRoot = deploymentRoot ? resolve(deploymentRoot) : undefined;
  const resolvedOutputDir = resolve(outputDir ?? process.cwd());
  if (
    (configPath && mode !== 'configure')
    || (managedMode && !isValidDeploymentRoot(deploymentRoot))
    || (!managedMode && deploymentRoot !== undefined)
    || (managedMode
      && resolvedDeploymentRoot !== undefined
      && resolvedOutputDir !== join(resolvedDeploymentRoot, 'shared'))
  ) {
    throw new Error('Invalid deployment arguments');
  }

  return {
    mode,
    ...(outputDir ? { outputDir } : {}),
    ...(configPath ? { configPath } : {}),
    ...(resolvedDeploymentRoot ? { deploymentRoot: resolvedDeploymentRoot } : {}),
    verifyNapCat,
    healthCheck,
  };
}

function isValidDeploymentRoot(value: string | undefined): value is string {
  return value !== undefined && isAbsolute(value) && !/[%$\r\n]/.test(value);
}

/**
 * CLI entry point
 */
async function main() {
  const options = parseDeploymentCliArgs(process.argv.slice(2));

  console.log('╔════════════════════════════════════════╗');
  console.log('║  LetheBot OneBot Deployment Tool      ║');
  console.log('╚════════════════════════════════════════╝\n');

  const result = await deployLetheBot(options);

  console.log('\n' + '═'.repeat(42));
  if (result.success) {
    console.log(`✓ ${redactForDisplay(result.message)}`);
    if (result.details) {
      console.log('\nDetails:');
      console.log(`  Config: ${redactForDisplay(result.details.configPath)}`);
      console.log(`  Server: ${redactForDisplay(result.details.serverUrl)}`);
      console.log(`  OneBot: ${redactForDisplay(result.details.oneBotUrl)}`);
      if (result.details.healthCheckPassed !== undefined) {
        console.log(`  Health: ${result.details.healthCheckPassed ? '✓' : '✗'}`);
      }
    }
  } else {
    console.log(`✗ ${redactForDisplay(result.message)}`);
    if (result.error) {
      console.error(`\nError: ${redactForDisplay(result.error.message)}`);
    }
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', display(error));
    process.exit(1);
  });
}
