import { mkdtempSync, rmSync } from 'node:fs';
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
const { EvaluatorDecisionRepository } = await import(
  '../../src/storage/evaluator-decision-repository.js'
);

describe('Pi runtime configuration wiring', () => {
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
      resetConfig();
      piAdapterConstructor.mockClear();

      app = new LetheBotApp();

      expect(piAdapterConstructor).toHaveBeenCalledTimes(1);
      expect(piAdapterConstructor.mock.calls[0]?.[0]).toMatchObject({
        provider: 'openai',
        model: 'gpt-4',
        turnTimeoutMs: 43_210,
        evaluator: expect.any(ModelEvaluator),
      });
      const memoryExtractor = Reflect.get(app, 'memoryExtractor') as object;
      const proposalService = Reflect.get(memoryExtractor, 'memoryProposalService') as object;
      const proposalOptions = Reflect.get(proposalService, 'options') as Record<string, unknown>;
      expect(proposalOptions).toMatchObject({
        evaluator: piAdapterConstructor.mock.calls[0]?.[0].evaluator,
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

        const registerBackgroundWorkerJobs = Reflect.get(
          app,
          'registerBackgroundWorkerJobs',
        ) as () => void;
        registerBackgroundWorkerJobs.call(app);
        const scheduler = Reflect.get(app, 'workerScheduler') as object;
        const registeredJobs = Reflect.get(scheduler, 'jobs') as Map<string, unknown>;
        expect(registeredJobs.has('summary-discovery')).toBe(enabled);

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
