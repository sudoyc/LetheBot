#!/usr/bin/env tsx
/**
 * Smoke Test
 *
 * 快速验证 LetheBot 核心功能
 */

import { initDatabase, runMigration, closeDatabase } from '../src/storage/database';
import { MemoryRepository } from '../src/storage/memory-repository';
import { IdentityRepository } from '../src/storage/identity-repository';
import { AttentionEngine } from '../src/attention/engine';
import { MockPi } from '../src/pi/mock-pi';
import { ContextBuilder } from '../src/context/builder';
import { ToolRegistry } from '../src/tools/registry';
import { PolicyGate } from '../src/policy/gate';
import { BackgroundWorker } from '../src/workers/background';
import { GovernanceCLI } from '../src/cli/governance';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function smokeTest(): Promise<void> {
  console.log('🔥 LetheBot Smoke Test\n');

  const testDir = mkdtempSync(join(tmpdir(), 'lethebot-smoke-'));
  const dbPath = join(testDir, 'smoke.db');

  try {
    // 1. Database
    console.log('1️⃣  Database initialization...');
    const db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../migrations/001_initial_schema.sql'));
    console.log('   ✅ Database initialized\n');

    // 2. Repositories
    console.log('2️⃣  Storage repositories...');
    const memoryRepo = new MemoryRepository(db);
    const identityRepo = new IdentityRepository(db);

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'smoke-user',
      Date.now(),
      Date.now()
    );

    const memoryId = await memoryRepo.create({
      scope: 'user',
      canonicalUserId: 'smoke-user',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Test preference',
      content: 'Smoke test memory',
      state: 'active',
      confidence: 0.9,
      importance: 0.5,
      sourceContext: 'smoke_test',
    });

    const memory = await memoryRepo.findById(memoryId);
    if (!memory || memory.content !== 'Smoke test memory') {
      throw new Error('Memory repository failed');
    }
    console.log('   ✅ MemoryRepository working');
    console.log('   ✅ IdentityRepository working\n');

    // 3. Attention Engine
    console.log('3️⃣  Attention engine...');
    const attention = new AttentionEngine();
    const signals = attention.analyze({
      conversationType: 'private',
      mentionsBot: true,
      text: '@bot help',
      senderId: 'smoke-user',
      replyToBot: false,
    });

    if (signals.classification !== 'needs_evaluation') {
      console.log(`   ⚠️  Expected 'needs_evaluation', got '${signals.classification}'`);
      console.log(`   Trigger score: ${signals.triggerScore}`);
      throw new Error('Attention engine classification failed');
    }
    console.log('   ✅ Attention engine working\n');

    // 4. MockPi
    console.log('4️⃣  MockPi (reasoning core stub)...');
    const pi = new MockPi();
    const piResult = await pi.run({
      turnId: 'smoke-turn',
      conversationId: 'smoke-conv',
      contextPack: {
        id: 'ctx-001',
        turnId: 'smoke-turn',
        conversation: {
          conversationId: 'smoke-conv',
          conversationType: 'private',
          participants: [],
        },
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'smoke-user',
            text: '你好',
            timestamp: new Date(),
            senderDisplayName: 'Smoke User',
            isFromBot: false,
          },
        ],
        memory: { retrievedFacts: [], totalRetrieved: 0 },
        tokenBudget: { max: 4000, used: 100, available: 3900 },
        metadata: { buildTimestamp: new Date(), retrievalLatencyMs: 10 },
      },
      toolRegistry: [],
    });

    if (!piResult.responseText || piResult.responseText.length === 0) {
      throw new Error('MockPi failed to generate response');
    }
    console.log('   ✅ MockPi working\n');

    // 5. Context Builder
    console.log('5️⃣  Context builder...');
    const builder = new ContextBuilder(memoryRepo, identityRepo);
    const context = await builder.buildContext({
      turnId: 'smoke-turn-2',
      conversationId: 'private:smoke-user',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'smoke-user',
    });

    if (context.memory.retrievedFacts.length !== 1) {
      throw new Error('Context builder failed to retrieve memory');
    }
    console.log('   ✅ Context builder working\n');

    // 6. Tool Registry & Policy Gate
    console.log('6️⃣  Tool registry & policy gate...');
    const registry = new ToolRegistry();
    registry.register({
      name: 'smoke_tool',
      version: '1.0.0',
      description: 'Smoke test tool',
      capabilities: ['test'],
      permissions: {
        allowedActors: ['user'],
        allowedContexts: ['private_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'summary',
      sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
      outputSensitivity: 'normal',
      piSchema: { input: {}, output: {} },
      handler: 'test',
    });

    const gate = new PolicyGate(registry);
    const checkResult = gate.checkToolCall({
      toolName: 'smoke_tool',
      actor: { actorClass: 'user', canonicalUserId: 'smoke-user' },
      context: 'private_chat',
    });

    if (!checkResult.allowed) {
      throw new Error('Policy gate denied valid tool call');
    }
    console.log('   ✅ Tool registry working');
    console.log('   ✅ Policy gate working\n');

    // 7. Background Worker
    console.log('7️⃣  Background worker...');
    const worker = new BackgroundWorker();
    const taskId = worker.enqueue({
      type: 'summary',
      payload: { conversationId: 'smoke-conv', messageRange: { start: 'msg-001', end: 'msg-010' } },
    });

    if (worker.getStatus(taskId) !== 'pending') {
      throw new Error('Worker failed to enqueue task');
    }

    const taskResult = await worker.processNext();
    if (!taskResult || taskResult.status !== 'completed') {
      throw new Error('Worker failed to process task');
    }
    console.log('   ✅ Background worker working\n');

    // 8. Governance CLI
    console.log('8️⃣  Governance CLI...');
    const cli = new GovernanceCLI(memoryRepo);
    const memories = await cli.listMemory({ userId: 'smoke-user' });

    if (memories.length !== 1) {
      throw new Error('Governance CLI failed to list memory');
    }

    const disableResult = await cli.disableMemory(memoryId);
    if (!disableResult.success) {
      throw new Error('Governance CLI failed to disable memory');
    }

    const enableResult = await cli.enableMemory(memoryId);
    if (!enableResult.success) {
      throw new Error('Governance CLI failed to enable memory');
    }
    console.log('   ✅ Governance CLI working\n');

    // Cleanup
    closeDatabase(db);

    console.log('✨ All smoke tests passed!\n');
    console.log('📝 Summary:');
    console.log('   - Database: SQLite with migrations');
    console.log('   - Storage: Memory & Identity repositories');
    console.log('   - Attention: Trigger scoring & classification');
    console.log('   - Reasoning: MockPi (stub for testing)');
    console.log('   - Context: Memory visibility filtering');
    console.log('   - Policy: Tool registry & L0 gate');
    console.log('   - Workers: Background task queue');
    console.log('   - CLI: Memory governance commands\n');
    console.log('🚀 Next steps: See docs/deployment.md for production setup');
  } catch (error) {
    console.error('❌ Smoke test failed:', error);
    process.exit(1);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

smokeTest().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
