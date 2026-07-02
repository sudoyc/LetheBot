#!/usr/bin/env tsx
/**
 * CLI Main Entry
 *
 * 治理命令行工具入口
 */

import { Command } from 'commander';
import { initDatabase, closeDatabase } from '../storage/database';
import { MemoryRepository } from '../storage/memory-repository';
import { IdentityRepository } from '../storage/identity-repository';
import { ContextBuilder } from '../context/builder';
import { GovernanceCLI } from './governance';
import { loadConfig } from '../config';

const program = new Command();
const config = loadConfig();

program
  .name('lethebot-cli')
  .description('LetheBot governance CLI')
  .version('0.1.0');

program
  .command('list-memory')
  .description('List memory records')
  .option('--user <userId>', 'Filter by user ID')
  .option('--group <groupId>', 'Filter by group ID')
  .option('--conversation <conversationId>', 'Filter by conversation ID')
  .option('--state <state>', 'Filter by state (active, proposed, disabled, deleted)')
  .option('--scope <scope>', 'Filter by memory scope')
  .option('--sensitivity <sensitivity>', 'Filter by sensitivity')
  .option('--source-context <sourceContext>', 'Filter by source context')
  .option('--source-type <sourceType>', 'Filter by linked source type')
  .option('--source-id <sourceId>', 'Filter by linked source ID')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const memories = await cli.listMemory({
        userId: options.user,
        groupId: options.group,
        conversationId: options.conversation,
        state: options.state,
        scope: options.scope,
        sensitivity: options.sensitivity,
        sourceContext: options.sourceContext,
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        limit: Number(options.limit),
      });

      console.log(`Found ${memories.length} memory records:\n`);
      for (const mem of memories) {
        console.log(`ID: ${mem.id}`);
        console.log(`  Scope: ${mem.scope}`);
        console.log(`  User: ${mem.canonicalUserId ?? 'N/A'}`);
        console.log(`  Group: ${mem.groupId ?? 'N/A'}`);
        console.log(`  Title: ${mem.title}`);
        console.log(`  Content: ${mem.content}`);
        console.log(`  State: ${mem.state}`);
        console.log(`  Visibility: ${mem.visibility}`);
        console.log(`  Confidence: ${mem.confidence}`);
        console.log(`  Created: ${mem.createdAt}`);
        console.log('');
      }
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('delete-memory')
  .description('Delete a memory record')
  .argument('<memoryId>', 'Memory ID to delete')
  .action(async (memoryId) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.deleteMemory(memoryId);
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('disable-memory')
  .description('Disable a memory record')
  .argument('<memoryId>', 'Memory ID to disable')
  .action(async (memoryId) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.disableMemory(memoryId);
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('enable-memory')
  .description('Enable a disabled memory record')
  .argument('<memoryId>', 'Memory ID to enable')
  .action(async (memoryId) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.enableMemory(memoryId);
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('why')
  .description('Explain context trace for a turn or conversation')
  .option('--turn <turnId>', 'Agent turn ID; defaults to latest turn')
  .option('--conversation <conversationId>', 'Conversation ID')
  .option('--type <type>', 'Conversation type (private, group)')
  .option('--group <groupId>', 'Group ID for group context')
  .option('--user <canonicalUserId>', 'Canonical user ID')
  .option('--limit <limit>', 'Recent message limit', '20')
  .action(async (options) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const identityRepo = new IdentityRepository(db);
    const contextBuilder = new ContextBuilder(memoryRepo, identityRepo, db);
    const cli = new GovernanceCLI(memoryRepo, { db, contextBuilder });

    try {
      const explanation = await cli.explainContext({
        turnId: options.turn,
        conversationId: options.conversation,
        conversationType: options.type,
        groupId: options.group,
        canonicalUserId: options.user,
        messageLimit: Number(options.limit),
      });

      console.log(`Context explanation for turn ${explanation.turnId}`);
      console.log(`ContextPack: ${explanation.contextPackId} (${explanation.traceSource})`);
      console.log(`Conversation: ${explanation.conversation.conversationId}`);
      console.log(`Selected memories: ${explanation.selectedMemoryIds.join(', ') || 'none'}`);
      console.log(`Candidate memories: ${explanation.candidateMemoryIds.join(', ') || 'none'}`);
      console.log(`Rejected memories: ${JSON.stringify(explanation.rejectedMemories)}`);
      console.log(`Filters: ${explanation.filtersApplied.join(', ')}`);
      console.log(`Identity fields: ${explanation.injectedIdentityFields.join(', ') || 'none'}`);
      console.log(`Recent messages: ${explanation.recentMessageIds.join(', ') || 'none'}`);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('redact-display-profile')
  .description('Redact display profile and nickname history for a user')
  .argument('<canonicalUserId>', 'Canonical user ID')
  .option('--group <groupId>', 'Only redact the group-scoped display profile/history')
  .action(async (canonicalUserId, options) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.redactDisplayProfile({
        canonicalUserId,
        groupId: options.group,
      });

      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
    } finally {
      closeDatabase(db);
    }
  });

program.parse();
