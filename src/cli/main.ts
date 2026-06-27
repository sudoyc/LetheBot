#!/usr/bin/env tsx
/**
 * CLI Main Entry
 *
 * 治理命令行工具入口
 */

import { Command } from 'commander';
import { initDatabase, closeDatabase } from '../storage/database';
import { MemoryRepository } from '../storage/memory-repository';
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
  .option('--state <state>', 'Filter by state (active, proposed, disabled, deleted)')
  .action(async (options) => {
    const db = initDatabase({ path: config.dbPath });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo);

    try {
      const memories = await cli.listMemory({
        userId: options.user,
        groupId: options.group,
        state: options.state,
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
    const cli = new GovernanceCLI(memoryRepo);

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
    const cli = new GovernanceCLI(memoryRepo);

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
    const cli = new GovernanceCLI(memoryRepo);

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

program.parse();
