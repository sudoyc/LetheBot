import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const piAdapterConstructor = vi.hoisted(() => vi.fn());

vi.mock('../../src/pi/pi-adapter.js', () => ({
  PiAdapter: piAdapterConstructor,
}));

const { LetheBotApp } = await import('../../src/index.js');
const { resetConfig } = await import('../../src/config/index.js');
const { ModelEvaluator } = await import('../../src/evaluator/model-evaluator.js');
const { ModelInvocationRepository } = await import(
  '../../src/storage/model-invocation-repository.js'
);
const { EvaluatorDecisionRepository } = await import(
  '../../src/storage/evaluator-decision-repository.js'
);
const { ToolRegistry } = await import('../../src/tools/registry.js');
const { KNOWN_TOOL_NAMES } = await import('../../src/tools/known-tools.js');

describe('Pi runtime configuration wiring', () => {
  it('registers only the reviewed production tool catalog', async () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-production-tool-catalog-'));
    let app: InstanceType<typeof LetheBotApp> | undefined;

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_TEST: 'true',
        LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        PI_PROVIDER: 'mock',
        PI_MODEL: 'mock',
        EVALUATOR_PROVIDER: 'mock',
        EVALUATOR_MODEL: 'mock',
      };
      delete process.env.LETHEBOT_WORKSPACE_ROOT;
      delete process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS;
      resetConfig();

      app = new LetheBotApp();
      const registry = Reflect.get(app, 'toolRegistry');
      expect(registry).toBeInstanceOf(ToolRegistry);
      const optionalNames = new Set(['workspace.list', 'workspace.read_text', 'web.fetch_text']);
      expect((registry as InstanceType<typeof ToolRegistry>).list()
        .map((entry) => entry.name)
        .sort()).toEqual(KNOWN_TOOL_NAMES.filter((name) => !optionalNames.has(name)).sort());
      expect((registry as InstanceType<typeof ToolRegistry>).get('runtime.tools')).toMatchObject({
        capabilities: ['read_local'],
        permissions: {
          allowedActors: ['owner', 'admin'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'redacted_full',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 1000,
          maxOutputBytes: 8192,
        },
        outputSensitivity: 'secret_possible',
      });
      for (const dormantName of [
        'read_file',
        'write_file',
        'list_directory',
        'delete_file',
        'network_request',
      ]) {
        expect((registry as InstanceType<typeof ToolRegistry>).get(dormantName)).toBeUndefined();
      }
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown disabled tools before opening the configured database', () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-disabled-tool-config-'));
    const dbPath = join(testDir, 'lethebot.db');

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_DB_PATH: dbPath,
        LETHEBOT_DISABLED_TOOLS: 'not.a.reviewed.tool',
      };
      resetConfig();

      expect(() => new LetheBotApp()).toThrow('Invalid configuration');
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts disabled optional tools when their prerequisites are absent', async () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-disabled-optional-tools-'));
    let app: InstanceType<typeof LetheBotApp> | undefined;

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_TEST: 'true',
        LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
        LETHEBOT_DISABLED_TOOLS: 'memory.search, workspace.list, workspace.read_text, web.fetch_text',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        PI_PROVIDER: 'mock',
        PI_MODEL: 'mock',
        EVALUATOR_PROVIDER: 'mock',
        EVALUATOR_MODEL: 'mock',
      };
      delete process.env.LETHEBOT_WORKSPACE_ROOT;
      delete process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS;
      resetConfig();

      app = new LetheBotApp();
      const registry = Reflect.get(app, 'toolRegistry') as InstanceType<typeof ToolRegistry>;
      expect(registry.get('memory.search')).toBeDefined();
      expect(registry.isEnabled('memory.search')).toBe(false);
      expect(registry.checkPermission(
        'memory.search',
        { actorClass: 'user' },
        'private_chat',
      )).toBe(false);
      expect(registry.getHandler('memory.search')).toBeUndefined();
      expect(registry.get('workspace.list')).toBeUndefined();
      expect(registry.get('workspace.read_text')).toBeUndefined();
      expect(registry.get('web.fetch_text')).toBeUndefined();
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('registers only the bounded workspace tools when an absolute root is configured', async () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-workspace-tool-catalog-'));
    const workspaceRoot = join(testDir, 'workspace');
    mkdirSync(workspaceRoot);
    let app: InstanceType<typeof LetheBotApp> | undefined;

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_TEST: 'true',
        LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
        LETHEBOT_WORKSPACE_ROOT: workspaceRoot,
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        PI_PROVIDER: 'mock',
        PI_MODEL: 'mock',
        EVALUATOR_PROVIDER: 'mock',
        EVALUATOR_MODEL: 'mock',
      };
      delete process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS;
      resetConfig();

      app = new LetheBotApp();
      const registry = Reflect.get(app, 'toolRegistry') as InstanceType<typeof ToolRegistry>;
      expect(registry.list().map((entry) => entry.name).sort()).toEqual([
        'group.recent_summary',
        'memory.disable',
        'memory.propose',
        'memory.search',
        'runtime.status',
        'runtime.tools',
        'workspace.list',
        'workspace.read_text',
      ]);
      expect(registry.get('workspace.list')).toMatchObject({
        capabilities: ['read_local'],
        permissions: {
          allowedActors: ['owner', 'admin'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'redacted_full',
        sandboxPolicy: {
          filesystem: 'readonly',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 1000,
          maxOutputBytes: 8192,
        },
        outputSensitivity: 'secret_possible',
      });
      expect(registry.get('workspace.read_text')).toMatchObject({
        capabilities: ['read_local'],
        permissions: {
          allowedActors: ['owner', 'admin'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'redacted_full',
        sandboxPolicy: {
          filesystem: 'readonly',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 1000,
          maxOutputBytes: 8192,
        },
        outputSensitivity: 'secret_possible',
      });
      for (const dormantName of [
        'read_file',
        'write_file',
        'list_directory',
        'delete_file',
        'network_request',
      ]) {
        expect(registry.get(dormantName)).toBeUndefined();
      }
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('registers only web.fetch_text when exact HTTPS origins are configured', async () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-web-fetch-tool-catalog-'));
    let app: InstanceType<typeof LetheBotApp> | undefined;

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_TEST: 'true',
        LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
        LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS: 'https://docs.example.invalid',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        PI_PROVIDER: 'mock',
        PI_MODEL: 'mock',
        EVALUATOR_PROVIDER: 'mock',
        EVALUATOR_MODEL: 'mock',
      };
      delete process.env.LETHEBOT_WORKSPACE_ROOT;
      resetConfig();

      app = new LetheBotApp();
      const registry = Reflect.get(app, 'toolRegistry') as InstanceType<typeof ToolRegistry>;
      expect(registry.list().map((entry) => entry.name).sort()).toEqual([
        'group.recent_summary',
        'memory.disable',
        'memory.propose',
        'memory.search',
        'runtime.status',
        'runtime.tools',
        'web.fetch_text',
      ]);
      expect(registry.get('web.fetch_text')).toMatchObject({
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
          allowedOrigins: ['https://docs.example.invalid'],
        },
        outputSensitivity: 'secret_possible',
      });
      expect(registry.get('network_request')).toBeUndefined();
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('composes all three reviewed opt-in tools without legacy handlers', async () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-opt-in-tool-catalog-'));
    const workspaceRoot = join(testDir, 'workspace');
    mkdirSync(workspaceRoot);
    let app: InstanceType<typeof LetheBotApp> | undefined;

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_TEST: 'true',
        LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
        LETHEBOT_WORKSPACE_ROOT: workspaceRoot,
        LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS: 'https://docs.example.invalid',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        PI_PROVIDER: 'mock',
        PI_MODEL: 'mock',
        EVALUATOR_PROVIDER: 'mock',
        EVALUATOR_MODEL: 'mock',
      };
      resetConfig();

      app = new LetheBotApp();
      const registry = Reflect.get(app, 'toolRegistry') as InstanceType<typeof ToolRegistry>;
      expect(registry.list().map((entry) => entry.name).sort()).toEqual([
        'group.recent_summary',
        'memory.disable',
        'memory.propose',
        'memory.search',
        'runtime.status',
        'runtime.tools',
        'web.fetch_text',
        'workspace.list',
        'workspace.read_text',
      ]);
      for (const dormantName of [
        'read_file',
        'write_file',
        'list_directory',
        'delete_file',
        'network_request',
      ]) {
        expect(registry.get(dormantName)).toBeUndefined();
      }
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('passes the configured cooperative turn timeout to the production adapter', async () => {
    const originalEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-pi-runtime-config-'));
    let app: InstanceType<typeof LetheBotApp> | undefined;

    try {
      process.env = {
        ...originalEnv,
        LETHEBOT_TEST: 'false',
        LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        PI_PROVIDER: 'openai',
        PI_MODEL: 'gpt-4',
        PI_API_KEY: 'test-only-explicit-key',
        PI_TURN_TIMEOUT_MS: '43210',
        EVALUATOR_PROVIDER: 'openai',
        EVALUATOR_MODEL: 'gpt-4',
        EVALUATOR_API_KEY: 'test-only-evaluator-key',
        EVALUATOR_TIMEOUT_MS: '9876',
        EVALUATOR_PROMPT_VERSION: 'runtime-wiring-v1',
      };
      delete process.env.LETHEBOT_WORKSPACE_ROOT;
      delete process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS;
      resetConfig();
      piAdapterConstructor.mockClear();

      app = new LetheBotApp();

      expect(piAdapterConstructor).toHaveBeenCalledTimes(1);
      const piOptions = piAdapterConstructor.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(piOptions).toMatchObject({
        provider: 'openai',
        model: 'gpt-4',
        turnTimeoutMs: 43_210,
        evaluator: expect.any(ModelEvaluator),
        modelInvocationRepository: expect.any(ModelInvocationRepository),
      });
      expect(piOptions.modelInvocationRepository).toBe(
        Reflect.get(piOptions.evaluator as object, 'invocationLedger'),
      );
      const memoryExtractor = Reflect.get(app, 'memoryExtractor') as object;
      const proposalService = Reflect.get(memoryExtractor, 'memoryProposalService') as object;
      const proposalOptions = Reflect.get(proposalService, 'options') as Record<string, unknown>;
      expect(proposalOptions).toMatchObject({
        evaluator: piOptions.evaluator,
        evaluatorDecisionWriter: expect.any(EvaluatorDecisionRepository),
      });
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    { enabled: false, envValue: undefined, expectedStatus: 'failed' as const },
    { enabled: true, envValue: 'true', expectedStatus: 'completed' as const },
  ])(
    'keeps background summary Provider access gated when enabled=$enabled',
    async ({ enabled, envValue, expectedStatus }) => {
      const originalEnv = process.env;
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-summary-gate-'));
      let app: InstanceType<typeof LetheBotApp> | undefined;

      try {
        process.env = {
          ...originalEnv,
          LETHEBOT_TEST: 'false',
          LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
          LOG_LEVEL: 'fatal',
          ONEBOT_TRANSPORT: 'http',
          PI_PROVIDER: 'mock',
          PI_MODEL: 'mock',
          EVALUATOR_PROVIDER: 'mock',
          EVALUATOR_MODEL: 'mock',
        };
        delete process.env.LETHEBOT_WORKSPACE_ROOT;
        delete process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS;
        if (envValue === undefined) {
          delete process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED;
        } else {
          process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED = envValue;
        }
        resetConfig();

        app = new LetheBotApp();
        const piRunTurn = vi.fn(async () => {
          throw new Error('Synthetic Provider runtime must not be called');
        });
        app.setPiRuntimeForTesting({ runTurn: piRunTurn });

        const backgroundRuntime = Reflect.get(app, 'backgroundRuntime') as object;
        const registerBackgroundWorkerJobs = Reflect.get(
          backgroundRuntime,
          'registerJobs',
        ) as () => void;
        registerBackgroundWorkerJobs.call(backgroundRuntime);
        const scheduler = Reflect.get(backgroundRuntime, 'workerScheduler') as object;
        const registeredJobs = Reflect.get(scheduler, 'jobs') as Map<string, unknown>;
        expect(registeredJobs.has('durable-background-job-processor')).toBe(true);
        expect(registeredJobs.has('durable-interactive-job-processor')).toBe(true);
        expect(registeredJobs.has('summary-discovery')).toBe(enabled);
        const maintenanceWorker = Reflect.get(backgroundRuntime, 'backgroundWorker') as object;
        const interactiveWorker = Reflect.get(
          backgroundRuntime,
          'interactiveBackgroundWorker',
        ) as object;
        expect(Reflect.get(maintenanceWorker, 'workerId')).toBe('lethebot-background-main');
        expect(Reflect.get(maintenanceWorker, 'claimTypes')).toBeUndefined();
        expect(Reflect.get(maintenanceWorker, 'excludedClaimTypes')).toEqual(['attention_recheck']);
        expect(Reflect.get(interactiveWorker, 'workerId')).toBe('lethebot-background-interactive');
        expect(Reflect.get(interactiveWorker, 'claimTypes')).toEqual(['attention_recheck']);
        expect(Reflect.get(interactiveWorker, 'excludedClaimTypes')).toBeUndefined();

        const taskId = app.enqueueBackgroundTaskForTesting({
          type: 'summary',
          payload: {
            conversationId: 'synthetic-empty-conversation',
            conversationType: 'private',
          },
          maxAttempts: 1,
        });
        const result = await app.processNextBackgroundJobForTesting();

        expect(result).toMatchObject({ taskId, status: expectedStatus });
        if (enabled) {
          expect(result?.output).toBeNull();
        } else {
          expect(result?.error).toContain('Background summary Provider processing is disabled');
        }
        expect(piRunTurn).not.toHaveBeenCalled();
        expect(
          app.getDatabase().prepare('SELECT COUNT(*) AS count FROM chat_messages').get(),
        ).toEqual({ count: 0 });
        expect(
          app.getDatabase().prepare(
            `SELECT
              (SELECT COUNT(*) FROM model_contexts) AS contexts,
              (SELECT COUNT(*) FROM model_invocations) AS invocations,
              (SELECT COUNT(*) FROM model_invocation_sources) AS sources`,
          ).get(),
        ).toEqual({ contexts: 0, invocations: 0, sources: 0 });
      } finally {
        await app?.stop();
        process.env = originalEnv;
        resetConfig();
        rmSync(testDir, { recursive: true, force: true });
      }
    },
  );
});
