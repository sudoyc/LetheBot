import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, loadNapCatConfig, resetConfig, ConfigValidationError } from '../../../src/config/index.js';

describe('NapCat Config Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  describe('loadNapCatConfig', () => {
    test('loads NapCat config with defaults', () => {
      delete process.env.ONEBOT_HTTP_URL;
      delete process.env.ONEBOT_TOKEN;
      delete process.env.LETHEBOT_PORT;
      delete process.env.LETHEBOT_HOST;

      const config = loadNapCatConfig();

      expect(config.httpUrl).toBe('http://localhost:3000');
      expect(config.token).toBeUndefined();
      expect(config.botQqId).toBeUndefined();
      expect(config.serverPort).toBe(6700);
      expect(config.serverHost).toBe('0.0.0.0');
      expect(config.healthCheckPath).toBe('/healthz');
      expect(config.eventPath).toBe('/onebot/event');
    });

    test('loads NapCat config from env vars', () => {
      process.env.ONEBOT_HTTP_URL = 'http://napcat.example.com:3000';
      process.env.ONEBOT_TOKEN = 'secret-token-123';
      process.env.LETHEBOT_BOT_QQ_ID = '3889000770';
      process.env.LETHEBOT_PORT = '8080';
      process.env.LETHEBOT_HOST = '127.0.0.1';
      process.env.LETHEBOT_HEALTH_PATH = '/health';
      process.env.LETHEBOT_EVENT_PATH = '/events';

      const config = loadNapCatConfig();

      expect(config.httpUrl).toBe('http://napcat.example.com:3000');
      expect(config.token).toBe('secret-token-123');
      expect(config.botQqId).toBe('3889000770');
      expect(config.serverPort).toBe(8080);
      expect(config.serverHost).toBe('127.0.0.1');
      expect(config.healthCheckPath).toBe('/health');
      expect(config.eventPath).toBe('/events');
    });

    test('validates httpUrl is a valid URL', () => {
      process.env.ONEBOT_HTTP_URL = 'not-a-valid-url';

      expect(() => loadNapCatConfig()).toThrow(ConfigValidationError);
    });

    test('validates port is in valid range', () => {
      process.env.LETHEBOT_PORT = '70000';

      expect(() => loadNapCatConfig()).toThrow(ConfigValidationError);
    });

    test('validates port is a positive integer', () => {
      process.env.LETHEBOT_PORT = '0';

      expect(() => loadNapCatConfig()).toThrow(ConfigValidationError);
    });

    test('token is optional', () => {
      delete process.env.ONEBOT_TOKEN;

      const config = loadNapCatConfig();

      expect(config.token).toBeUndefined();
    });
  });

  describe('Config integration with main config', () => {
    test('NapCat config does not break existing config', () => {
      process.env.LOG_LEVEL = 'debug';
      process.env.LETHEBOT_DB_PATH = '/custom/db.sqlite';
      process.env.ONEBOT_HTTP_URL = 'http://localhost:3000';

      const mainConfig = loadConfig();
      const napCatConfig = loadNapCatConfig();

      expect(mainConfig.logLevel).toBe('debug');
      expect(mainConfig.dbPath).toBe('/custom/db.sqlite');
      expect(napCatConfig.httpUrl).toBe('http://localhost:3000');
    });

    test('ConfigValidationError contains detailed issues', () => {
      process.env.ONEBOT_HTTP_URL = 'invalid-url';
      process.env.LETHEBOT_PORT = 'not-a-number';

      try {
        loadNapCatConfig();
        expect.fail('Should have thrown ConfigValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        if (error instanceof ConfigValidationError) {
          expect(error.issues.length).toBeGreaterThan(0);
          expect(error.issues.some((issue) => issue.path.includes('onebotHttpUrl'))).toBe(true);
        }
      }
    });
  });

  describe('Edge cases', () => {
    test('handles empty string for optional token', () => {
      process.env.ONEBOT_TOKEN = '';

      const config = loadNapCatConfig();

      // Empty string should be treated as undefined/optional
      expect(config.token === '' || config.token === undefined).toBe(true);
    });

    test('handles URL with path', () => {
      process.env.ONEBOT_HTTP_URL = 'http://localhost:3000/api/v1';

      const config = loadNapCatConfig();

      expect(config.httpUrl).toBe('http://localhost:3000/api/v1');
    });

    test('handles HTTPS URL', () => {
      process.env.ONEBOT_HTTP_URL = 'https://napcat.example.com:443';

      const config = loadNapCatConfig();

      expect(config.httpUrl).toBe('https://napcat.example.com:443');
    });

    test('handles localhost variations', () => {
      process.env.ONEBOT_HTTP_URL = 'http://127.0.0.1:3000';

      const config = loadNapCatConfig();

      expect(config.httpUrl).toBe('http://127.0.0.1:3000');
    });
  });
});
