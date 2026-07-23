import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { GovernanceCLI } from '../../src/cli/governance.js';
import {
  ContextBuilder,
  type BuildContextInput,
} from '../../src/context/builder.js';
import {
  ContextTraceRepository,
  type StoredContextTrace,
} from '../../src/storage/context-trace-repository.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../src/storage/database.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import type { ContextPack } from '../../src/types/context.js';

const USER_ID = 'actor-alpha';
const ACCOUNT_ID = 'account-alpha';
const SOURCE_GROUP_ID = 'room-alpha';
const SOURCE_CONVERSATION_ID = 'thread-alpha';
const RAW_EVENT_ID = 'raw-source-alpha';
const CHAT_MESSAGE_ID = 'chat-source-alpha';
const MEMORY_ID = 'memory-process-restart';
const SOURCE_TIMESTAMP = Date.UTC(2026, 6, 14, 0, 0, 0);

interface DatabaseEvidence {
  memoryCount: number;
  sourceCount: number;
  revisionCount: number;
  auditCount: number;
  integrityOk: boolean;
  foreignKeyViolationCount: number;
}

interface BuiltContext {
  context: ContextPack;
  stored: StoredContextTrace | null;
}

interface RecallTrigger {
  rawEventId: string;
  createdAt: number;
}

async function seed(dbPath: string): Promise<void> {
  const db = initDatabase({ path: dbPath });

  try {
    runMigrations(db, join(process.cwd(), 'migrations'));
    seedSourceEvidence(db);

    const memoryRepository = new MemoryRepository(db);
    const createdMemoryId = await memoryRepository.create({
      id: MEMORY_ID,
      scope: 'user',
      canonicalUserId: USER_ID,
      groupId: SOURCE_GROUP_ID,
      visibility: 'same_group_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Restart verification preference',
      content: 'prefers deterministic restart checks',
      state: 'proposed',
      confidence: 0.9,
      importance: 0.8,
      sourceContext: `group_chat:${SOURCE_GROUP_ID}`,
      sources: [{
        sourceType: 'chat_message',
        sourceId: CHAT_MESSAGE_ID,
        sourceTimestamp: SOURCE_TIMESTAMP,
        extractedBy: 'user',
      }],
    });
    const proposedBeforeApproval = (await memoryRepository.findById(createdMemoryId))?.state
      === 'proposed';
    const approval = await new GovernanceCLI(memoryRepository, { db }).approveMemory(
      createdMemoryId,
    );
    const activeAfterApproval = approval.success
      && (await memoryRepository.findById(createdMemoryId))?.state === 'active';

    emit({
      phase: 'seed',
      proposedBeforeApproval,
      activeAfterApproval,
      ...collectDatabaseEvidence(db),
    });
  } finally {
    closeDatabase(db);
  }
}

async function recall(dbPath: string): Promise<void> {
  const db = initDatabase({ path: dbPath });

  try {
    runMigrations(db, join(process.cwd(), 'migrations'));
    const memoryRepository = new MemoryRepository(db);
    const contextBuilder = new ContextBuilder(
      db,
      memoryRepository,
      new IdentityRepository(db),
    );
    const traceRepository = new ContextTraceRepository(db);

    const sameGroup = await buildAndStoreContext(db, contextBuilder, traceRepository, {
      turnId: 'turn-same-group',
      conversationId: SOURCE_CONVERSATION_ID,
      conversationType: 'group',
      groupId: SOURCE_GROUP_ID,
      targetUserId: USER_ID,
    });
    const otherGroup = await buildAndStoreContext(db, contextBuilder, traceRepository, {
      turnId: 'turn-other-group',
      conversationId: 'thread-beta',
      conversationType: 'group',
      groupId: 'room-beta',
      targetUserId: USER_ID,
    });
    const privateConversation = await buildAndStoreContext(
      db,
      contextBuilder,
      traceRepository,
      {
        turnId: 'turn-private',
        conversationId: 'private-thread-alpha',
        conversationType: 'private',
        targetUserId: USER_ID,
      },
    );
    const contexts = [sameGroup, otherGroup, privateConversation];

    emit({
      phase: 'recall',
      sameGroup: {
        selectedCount: sameGroup.context.memory.selectedMemoryIds.length,
        selectedTarget: sameGroup.context.memory.selectedMemoryIds.length === 1
          && sameGroup.context.memory.selectedMemoryIds[0] === MEMORY_ID,
      },
      otherGroup: {
        selectedCount: otherGroup.context.memory.selectedMemoryIds.length,
        rejectedTargetForScope: rejectedTargetForScope(otherGroup.context),
      },
      privateConversation: {
        selectedCount: privateConversation.context.memory.selectedMemoryIds.length,
        rejectedTargetForScope: rejectedTargetForScope(privateConversation.context),
      },
      storedTraceCount: queryCount(db, 'SELECT COUNT(*) AS count FROM context_traces'),
      roundTrippedTraceCount: contexts.filter(traceRoundTripped).length,
      mismatchedTurnTriggerCount: queryCount(
        db,
        `SELECT COUNT(*) AS count
           FROM agent_turns AS turn
           JOIN raw_events AS raw ON raw.id = turn.trigger_event_id
           JOIN chat_messages AS message ON message.raw_event_id = raw.id
          WHERE turn.id IN ('turn-same-group', 'turn-other-group', 'turn-private')
            AND (
              raw.conversation_id <> turn.conversation_id
              OR message.conversation_id <> turn.conversation_id
            )`,
      ),
      invalidTurnChronologyCount: queryCount(
        db,
        `SELECT COUNT(DISTINCT turn.id) AS count
           FROM agent_turns AS turn
           JOIN raw_events AS raw ON raw.id = turn.trigger_event_id
           JOIN chat_messages AS message ON message.raw_event_id = raw.id
           LEFT JOIN context_traces AS trace
             ON trace.id = turn.context_pack_id AND trace.turn_id = turn.id
          WHERE turn.id IN ('turn-same-group', 'turn-other-group', 'turn-private')
            AND (
              trace.id IS NULL
              OR turn.completed_at IS NULL
              OR raw.created_at > turn.started_at
              OR message.timestamp > turn.started_at
              OR turn.started_at > trace.created_at
              OR trace.created_at > turn.completed_at
            )`,
      ),
      ...collectDatabaseEvidence(db),
    });
  } finally {
    closeDatabase(db);
  }
}

function seedSourceEvidence(db: Database.Database): void {
  db.prepare(
    `INSERT INTO canonical_users (id, created_at, last_seen_at)
     VALUES (?, ?, ?)`,
  ).run(USER_ID, SOURCE_TIMESTAMP, SOURCE_TIMESTAMP);
  db.prepare(
    `INSERT INTO platform_accounts (
       platform, platform_account_id, canonical_user_id, account_type,
       verified_level, status, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'qq',
    ACCOUNT_ID,
    USER_ID,
    'group_member',
    'observed',
    'active',
    SOURCE_TIMESTAMP,
    SOURCE_TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id,
       platform_event_id, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RAW_EVENT_ID,
    'chat.message.received',
    SOURCE_TIMESTAMP,
    'gateway',
    'qq',
    SOURCE_CONVERSATION_ID,
    'event-alpha',
    '{}',
    SOURCE_TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO chat_messages (
       id, raw_event_id, message_id, conversation_id, conversation_type,
       group_id, sender_id, sender_role, text, has_media, has_quote,
       mentions_bot, timestamp
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CHAT_MESSAGE_ID,
    RAW_EVENT_ID,
    'message-alpha',
    SOURCE_CONVERSATION_ID,
    'group',
    SOURCE_GROUP_ID,
    ACCOUNT_ID,
    'member',
    'prefers deterministic restart checks',
    0,
    0,
    0,
    SOURCE_TIMESTAMP,
  );
}

async function buildAndStoreContext(
  db: Database.Database,
  contextBuilder: ContextBuilder,
  traceRepository: ContextTraceRepository,
  input: BuildContextInput & { turnId: string },
): Promise<BuiltContext> {
  const trigger = seedRecallTrigger(db, input);
  insertTurn(db, input.turnId, input.conversationId, trigger);
  const context = await contextBuilder.buildContext(input);
  await traceRepository.createFromContext(context);
  completeTurn(db, input.turnId, context.id, context.createdAt.getTime());

  return {
    context,
    stored: await traceRepository.findByTurnId(input.turnId),
  };
}

function seedRecallTrigger(
  db: Database.Database,
  input: BuildContextInput & { turnId: string },
): RecallTrigger {
  const suffix = input.turnId.replace(/[^A-Za-z0-9_-]/g, '-');
  const rawEventId = `raw-${suffix}`;
  const chatMessageId = `chat-${suffix}`;
  const timestamp = SOURCE_TIMESTAMP + 10_000 + queryCount(
    db,
    'SELECT COUNT(*) AS count FROM raw_events',
  );
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id,
       platform_event_id, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rawEventId,
    'chat.message.received',
    timestamp,
    'gateway',
    'qq',
    input.conversationId,
    `event-${suffix}`,
    '{}',
    timestamp,
  );
  db.prepare(
    `INSERT INTO chat_messages (
       id, raw_event_id, message_id, conversation_id, conversation_type,
       group_id, sender_id, sender_role, text, has_media, has_quote,
       mentions_bot, timestamp
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatMessageId,
    rawEventId,
    `message-${suffix}`,
    input.conversationId,
    input.conversationType,
    input.groupId ?? null,
    ACCOUNT_ID,
    input.conversationType === 'group' ? 'member' : null,
    'synthetic recall probe',
    0,
    0,
    1,
    timestamp,
  );
  return { rawEventId, createdAt: timestamp };
}

function insertTurn(
  db: Database.Database,
  turnId: string,
  conversationId: string,
  trigger: RecallTrigger,
): void {
  db.prepare(
    `INSERT INTO agent_turns (
       id, conversation_id, trigger_event_id, pi_model, pi_provider,
       status, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turnId,
    conversationId,
    trigger.rawEventId,
    'mock',
    'mock',
    'running',
    trigger.createdAt,
  );
}

function completeTurn(
  db: Database.Database,
  turnId: string,
  contextPackId: string,
  completedAt: number,
): void {
  db.prepare(
    `UPDATE agent_turns
        SET context_pack_id = ?, status = 'completed', completed_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(contextPackId, completedAt, turnId);
}

function rejectedTargetForScope(context: ContextPack): boolean {
  return context.trace?.rejectedMemories.some((rejection) => (
    rejection.memoryId === MEMORY_ID && rejection.reason === 'not_same_group_context'
  )) ?? false;
}

function traceRoundTripped(built: BuiltContext): boolean {
  const { context, stored } = built;
  if (!stored) {
    return false;
  }

  return stored.contextPackId === context.id
    && stored.turnId === context.turnId
    && JSON.stringify(stored.selectedMemoryIds)
      === JSON.stringify(context.memory.selectedMemoryIds)
    && JSON.stringify(stored.rejectedMemories)
      === JSON.stringify(context.trace?.rejectedMemories ?? []);
}

function collectDatabaseEvidence(db: Database.Database): DatabaseEvidence {
  const integrity = db.prepare('PRAGMA integrity_check').get() as
    | { integrity_check: string }
    | undefined;

  return {
    memoryCount: queryCount(
      db,
      'SELECT COUNT(*) AS count FROM memory_records WHERE id = ?',
      MEMORY_ID,
    ),
    sourceCount: queryCount(
      db,
      'SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?',
      MEMORY_ID,
    ),
    revisionCount: queryCount(
      db,
      'SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?',
      MEMORY_ID,
    ),
    auditCount: queryCount(
      db,
      'SELECT COUNT(*) AS count FROM audit_log WHERE category = ? AND event_id = ?',
      'memory',
      MEMORY_ID,
    ),
    integrityOk: integrity?.integrity_check === 'ok',
    foreignKeyViolationCount: db.prepare('PRAGMA foreign_key_check').all().length,
  };
}

function queryCount(db: Database.Database, sql: string, ...parameters: unknown[]): number {
  const row = db.prepare(sql).get(...parameters) as { count: number } | undefined;
  return row?.count ?? 0;
}

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  const dbPath = process.argv[3];
  if ((phase !== 'seed' && phase !== 'recall') || dbPath === undefined) {
    throw new Error('Usage: process-restart-memory-recall <seed|recall> <database-path>');
  }

  if (phase === 'seed') {
    await seed(dbPath);
  } else {
    await recall(dbPath);
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
