/**
 * Integration Test: Memory Extraction
 *
 * 验证记忆提取功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database.js';
import { MemoryExtractionWorker } from '../../src/workers/memory-extraction.js';
import type { Database } from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Memory Extraction', () => {
  let db: Database;
  let extractor: MemoryExtractionWorker;
  const testDbPath = join(__dirname, '../../data/test-memory-extraction.db');

  beforeEach(() => {
    // 清理测试数据库
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }

    // 确保目录存在
    const dataDir = dirname(testDbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // 初始化数据库
    db = initDatabase({ path: testDbPath });

    // 运行迁移
    const migrationPath = join(__dirname, '../../migrations/001_initial_schema.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    db.exec(sql);

    // 初始化提取器
    extractor = new MemoryExtractionWorker(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should extract name from user message', async () => {
    await extractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: '123456',
      userMessage: '我叫 Alice',
      botResponse: '你好 Alice',
    });

    const memories = db.prepare(`
      SELECT * FROM memory_records
      WHERE canonical_user_id = ?
    `).all('123456') as any[];

    expect(memories).toHaveLength(1);
    expect(memories[0].title).toContain('name');
    expect(memories[0].title).toContain('Alice');
    expect(memories[0].content).toBe('我叫 Alice');
    expect(memories[0].state).toBe('active');
  });

  it('should extract preference from user message', async () => {
    await extractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: '123456',
      userMessage: '我喜欢看科幻电影',
      botResponse: '科幻电影很有趣',
    });

    const memories = db.prepare(`
      SELECT * FROM memory_records
      WHERE content LIKE '%科幻电影%'
    `).all() as any[];

    expect(memories).toHaveLength(1);
    expect(memories[0].scope).toBe('user');
    expect(memories[0].visibility).toBe('private_only');
    expect(memories[0].kind).toBe('preference');
  });

  it('should extract multiple patterns from same message', async () => {
    await extractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: '123456',
      userMessage: '我叫 Bob，我喜欢编程',
      botResponse: '好的',
    });

    const memories = db.prepare(`
      SELECT * FROM memory_records
      WHERE canonical_user_id = ?
    `).all('123456') as any[];

    expect(memories.length).toBeGreaterThanOrEqual(2);
    const titles = memories.map(m => m.title);
    expect(titles.some(t => t.includes('name'))).toBe(true);
    expect(titles.some(t => t.includes('preference'))).toBe(true);
  });

  it('should handle messages without patterns', async () => {
    await extractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: '123456',
      userMessage: '今天天气真好',
      botResponse: '是的',
    });

    const memories = db.prepare(`
      SELECT * FROM memory_records
      WHERE canonical_user_id = ?
    `).all('123456') as any[];

    expect(memories).toHaveLength(0);
  });

  it('should set correct sensitivity levels', async () => {
    await extractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: '123456',
      userMessage: '我叫 Charlie',
      botResponse: '好的',
    });

    const memory = db.prepare(`
      SELECT * FROM memory_records
      WHERE canonical_user_id = ?
    `).get('123456') as any;

    expect(memory.sensitivity).toBe('personal');
  });

  it('should store source context', async () => {
    const conversationId = 'conv-test-123';

    await extractor.extractFromTurn({
      conversationId,
      userId: '123456',
      userMessage: '我喜欢红色',
      botResponse: '好的',
    });

    const memory = db.prepare(`
      SELECT * FROM memory_records
      WHERE canonical_user_id = ?
    `).get('123456') as any;

    expect(memory.source_context).toBe(`chat:${conversationId}`);
  });

  it('should set high confidence for explicit statements', async () => {
    await extractor.extractFromTurn({
      conversationId: 'conv-1',
      userId: '123456',
      userMessage: '我需要学习 TypeScript',
      botResponse: '好的',
    });

    const memory = db.prepare(`
      SELECT * FROM memory_records
      WHERE canonical_user_id = ?
    `).get('123456') as any;

    expect(memory.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
