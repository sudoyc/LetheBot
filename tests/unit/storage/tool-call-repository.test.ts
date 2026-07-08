import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { ToolCallRepository } from '../../../src/storage/tool-call-repository';

describe('ToolCallRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: ToolCallRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-tool-call-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new ToolCallRepository(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-tool', 'message.private', now, 'gateway', 'qq', 'conv-tool', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-tool', 'conv-tool', 'evt-tool', 'mock', 'mock', 'running', now);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('persists tool calls linked to agent turns', async () => {
    await repo.create({
      id: 'tc-001',
      turnId: 'turn-tool',
      toolName: 'test.tool',
      input: { query: 'hello' },
      output: { ok: true },
      requestedBy: 'pi',
      actor: { canonicalUserId: 'user-alice', actorClass: 'user' },
      context: 'private_chat',
      status: 'success',
      executionTimeMs: 12,
      secretsRedacted: false,
    });

    const record = await repo.findById('tc-001');
    const byTurn = await repo.listByTurnId('turn-tool');
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();

    expect(record).toMatchObject({
      id: 'tc-001',
      turnId: 'turn-tool',
      toolName: 'test.tool',
      input: { query: 'hello' },
      output: { ok: true },
      requestedBy: 'pi',
      actor: { canonicalUserId: 'user-alice', actorClass: 'user' },
      context: 'private_chat',
      status: 'success',
      executionTimeMs: 12,
      secretsRedacted: false,
    });
    expect(byTurn.map((toolCall) => toolCall.id)).toEqual(['tc-001']);
    expect(fkCheck).toHaveLength(0);
  });

  it('redacts sensitive tool call payloads and errors before durable persistence', async () => {
    await repo.create({
      id: 'tc-sensitive',
      turnId: 'turn-tool',
      toolName: 'sensitive.tool',
      input: {
        'lookup_sk-tool-call-secret-should-not-persist': 'api_key=sk-tool-call-input-secret-should-not-persist',
        userId: 1234567890,
        targetUserId: 2233445566,
        nested: {
          senderIds: [1234567891, 42],
          recipientGroupIds: [3344556677],
          note: 'legacy_qq-1234567892',
        },
      },
      output: {
        ok: true,
        token: 'token=sk-tool-call-output-secret-should-not-persist',
        messageId: 1234567893,
        ownerMessageId: 4455667788,
      },
      requestedBy: 'pi',
      actor: { canonicalUserId: 'user-alice', actorClass: 'user' },
      context: 'private_chat',
      status: 'error',
      errorCode: 'legacy_qq-1234567894',
      errorMessage: 'failed for sk-tool-call-error-secret-should-not-persist and qq-1234567895',
      secretsRedacted: false,
    });

    const rawRow = db
      .prepare('SELECT input, output, error_code, error_message, secrets_redacted FROM tool_calls WHERE id = ?')
      .get('tc-sensitive') as {
        input: string;
        output: string;
        error_code: string;
        error_message: string;
        secrets_redacted: number;
      };
    const serializedRawRow = JSON.stringify(rawRow);
    const record = await repo.findById('tc-sensitive');

    expect(serializedRawRow).not.toContain('sk-tool-call-input-secret-should-not-persist');
    expect(serializedRawRow).not.toContain('sk-tool-call-output-secret-should-not-persist');
    expect(serializedRawRow).not.toContain('sk-tool-call-error-secret-should-not-persist');
    expect(serializedRawRow).not.toContain('1234567890');
    expect(serializedRawRow).not.toContain('1234567891');
    expect(serializedRawRow).not.toContain('1234567892');
    expect(serializedRawRow).not.toContain('1234567893');
    expect(serializedRawRow).not.toContain('1234567894');
    expect(serializedRawRow).not.toContain('1234567895');
    expect(serializedRawRow).not.toContain('2233445566');
    expect(serializedRawRow).not.toContain('3344556677');
    expect(serializedRawRow).not.toContain('4455667788');
    expect(serializedRawRow).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedRawRow).toContain('[REDACTED:platform_id]');
    expect(rawRow.secrets_redacted).toBe(1);

    expect(record).toMatchObject({
      id: 'tc-sensitive',
      input: {
        'lookup_[REDACTED:openai_like_api_key]': '[REDACTED:api_key_assignment]',
        userId: '[REDACTED:platform_id]',
        targetUserId: '[REDACTED:platform_id]',
        nested: {
          senderIds: ['[REDACTED:platform_id]', 42],
          recipientGroupIds: ['[REDACTED:platform_id]'],
          note: 'legacy_[REDACTED:platform_id]',
        },
      },
      output: {
        ok: true,
        token: '[REDACTED:token_assignment]',
        messageId: '[REDACTED:platform_id]',
        ownerMessageId: '[REDACTED:platform_id]',
      },
      errorCode: 'legacy_[REDACTED:platform_id]',
      errorMessage: 'failed for [REDACTED:openai_like_api_key] and [REDACTED:platform_id]',
      secretsRedacted: true,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform tool call payloads and errors', async () => {
    await repo.create({
      id: 'tc-adjacent',
      turnId: 'turn-tool',
      toolName: 'adjacent.tool',
      input: {
        note: 'input sk-tool-call-adjacent-input-secret-should-not-persist-qq-12345678901',
        nested: {
          'key-sk-tool-call-adjacent-key-secret-should-not-persist-qq-12345678902': 'value',
        },
      },
      output: {
        result: 'output sk-tool-call-adjacent-output-secret-should-not-persist-qq-12345678903',
      },
      requestedBy: 'pi',
      actor: { canonicalUserId: 'user-alice', actorClass: 'user' },
      context: 'private_chat',
      status: 'error',
      errorCode: 'code-sk-tool-call-adjacent-code-secret-should-not-persist-qq-12345678904',
      errorMessage: 'error sk-tool-call-adjacent-error-secret-should-not-persist-qq-12345678905',
      secretsRedacted: false,
    });

    const rawRow = db
      .prepare('SELECT input, output, error_code, error_message, secrets_redacted FROM tool_calls WHERE id = ?')
      .get('tc-adjacent') as {
        input: string;
        output: string;
        error_code: string;
        error_message: string;
        secrets_redacted: number;
      };
    const storedInput = JSON.parse(rawRow.input) as {
      note: string;
      nested: Record<string, unknown>;
    };
    const storedOutput = JSON.parse(rawRow.output) as { result: string };
    const nestedKey = Object.keys(storedInput.nested)[0] ?? '';
    const serializedRawRow = JSON.stringify(rawRow);

    for (const value of [
      storedInput.note,
      nestedKey,
      storedOutput.result,
      rawRow.error_code,
      rawRow.error_message,
    ]) {
      expect(value).toContain('[REDACTED:openai_like_api_key]');
      expect(value).toContain('[REDACTED:platform_id]');
    }

    expect(serializedRawRow).not.toContain('sk-tool-call-adjacent');
    expect(serializedRawRow).not.toContain('qq-12345678901');
    expect(serializedRawRow).not.toContain('qq-12345678902');
    expect(serializedRawRow).not.toContain('qq-12345678903');
    expect(serializedRawRow).not.toContain('qq-12345678904');
    expect(serializedRawRow).not.toContain('qq-12345678905');
    expect(serializedRawRow).not.toContain('12345678901');
    expect(serializedRawRow).not.toContain('12345678902');
    expect(serializedRawRow).not.toContain('12345678903');
    expect(serializedRawRow).not.toContain('12345678904');
    expect(serializedRawRow).not.toContain('12345678905');
    expect(rawRow.secrets_redacted).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped secret/platform tool call payloads and errors', async () => {
    await repo.create({
      id: 'tc-assignment-adjacent',
      turnId: 'turn-tool',
      toolName: 'assignment.tool',
      input: {
        note: 'api_key=sk-tool-call-assignment-input-secret-should-not-persist-qq-22334455667',
        nested: {
          'key api_key=sk-tool-call-assignment-key-secret-should-not-persist-qq-22334455668': 'value',
        },
      },
      output: {
        result: 'api_key=sk-tool-call-assignment-output-secret-should-not-persist-qq-22334455669',
      },
      requestedBy: 'pi',
      actor: { canonicalUserId: 'user-alice', actorClass: 'user' },
      context: 'private_chat',
      status: 'error',
      errorCode: 'api_key=sk-tool-call-assignment-code-secret-should-not-persist-qq-22334455670',
      errorMessage: 'api_key=sk-tool-call-assignment-error-secret-should-not-persist-qq-22334455671',
      secretsRedacted: false,
    });

    const rawRow = db
      .prepare('SELECT input, output, error_code, error_message, secrets_redacted FROM tool_calls WHERE id = ?')
      .get('tc-assignment-adjacent') as {
        input: string;
        output: string;
        error_code: string;
        error_message: string;
        secrets_redacted: number;
      };
    const storedInput = JSON.parse(rawRow.input) as {
      note: string;
      nested: Record<string, unknown>;
    };
    const storedOutput = JSON.parse(rawRow.output) as { result: string };
    const nestedKey = Object.keys(storedInput.nested)[0] ?? '';
    const serializedRawRow = JSON.stringify(rawRow);

    for (const value of [
      storedInput.note,
      nestedKey,
      storedOutput.result,
      rawRow.error_code,
      rawRow.error_message,
    ]) {
      expect(value).toContain('[REDACTED:api_key_assignment]');
      expect(value).toContain('[REDACTED:platform_id]');
    }

    expect(serializedRawRow).not.toContain('sk-tool-call-assignment');
    expect(serializedRawRow).not.toContain('qq-22334455667');
    expect(serializedRawRow).not.toContain('qq-22334455668');
    expect(serializedRawRow).not.toContain('qq-22334455669');
    expect(serializedRawRow).not.toContain('qq-22334455670');
    expect(serializedRawRow).not.toContain('qq-22334455671');
    expect(serializedRawRow).not.toContain('22334455667');
    expect(serializedRawRow).not.toContain('22334455668');
    expect(serializedRawRow).not.toContain('22334455669');
    expect(serializedRawRow).not.toContain('22334455670');
    expect(serializedRawRow).not.toContain('22334455671');
    expect(rawRow.secrets_redacted).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
