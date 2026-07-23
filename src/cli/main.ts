#!/usr/bin/env tsx
/**
 * CLI Main Entry
 *
 * 治理命令行工具入口
 */

import { Command } from 'commander';
import {
  formatGovernanceMemoryIdForDisplay,
  GovernanceService,
} from '../governance/service.js';
import { initDatabase, closeDatabase } from '../storage/database.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { IdentityRepository } from '../storage/identity-repository.js';
import { ContextBuilder } from '../context/builder.js';
import {
  GovernanceCLI,
  type CommandResult,
  type GovernanceHealthSummaryInspectionRecord,
  type MemoryReviewAuditEventType,
  type MemoryReviewResolutionStatus,
} from './governance.js';
import { loadConfig } from '../config/index.js';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type {
  PrivacyPreferenceState,
  PrivacyPreferenceType,
} from '../storage/privacy-preference-repository.js';
import type {
  JobAttemptStatus,
  JobStatus,
  WorkerHeartbeatStatus,
} from '../storage/job-repository.js';
import type { ActionDecision, ActionExecutionResult, ActionType } from '../types/action.js';
import type { AuditEntry } from '../types/audit.js';
import type { MemoryRecord, MemorySource } from '../types/memory.js';
import type { ToolCallResult } from '../types/tool.js';

const program = new Command();

const EVENT_PROCESSING_FAILURE_STAGES = [
  'raw_event_store',
  'identity_resolution',
  'display_metadata',
  'chat_message_store',
  'governance_command',
  'attention_analysis',
  'delayed_attention_persist',
  'turn_create',
  'context_building',
  'pi_inference',
  'social_decision',
  'action_execution',
  'bot_response_persist',
  'memory_extraction',
  'turn_complete',
] as const;

type EventProcessingFailureStage = typeof EVENT_PROCESSING_FAILURE_STAGES[number];
type MemorySummaryAction = 'status' | 'enable' | 'disable';
const MAX_CLI_ERROR_LENGTH = 2_048;
const CLI_ERROR_PREFIX = '❌ ';

function getDbPath(): string {
  return loadConfig().dbPath;
}

async function withGovernanceCli<T>(callback: (cli: GovernanceCLI) => Promise<T>): Promise<T> {
  const db = initDatabase({ path: getDbPath() });
  const memoryRepo = new MemoryRepository(db);
  const cli = new GovernanceCLI(memoryRepo, { db });

  try {
    return await callback(cli);
  } finally {
    closeDatabase(db);
  }
}

function printCommandResult(result: CommandResult): void {
  if (result.success) {
    console.log(`✅ ${redactForDisplay(result.message ?? 'Command completed')}`);
    return;
  }

  console.error(
    `${CLI_ERROR_PREFIX}${projectCliErrorForDisplay(
      result.error ?? 'Command failed',
      MAX_CLI_ERROR_LENGTH - CLI_ERROR_PREFIX.length,
    )}`,
  );
  process.exitCode = 1;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function compactGovernanceHealth(summary: GovernanceHealthSummaryInspectionRecord): {
  generatedAt: Date;
  overall: 'ok' | 'attention_required';
  attention: GovernanceHealthSummaryInspectionRecord['attention'];
  totals: {
    memoryReviews: number;
    eventProcessingFailures: number;
    actionDecisions: number;
    actionExecutions: number;
    toolCalls: number;
    jobs: number;
    workerHeartbeats: number;
    auditEvents: number;
  };
  latest: {
    eventFailureAt?: Date;
    workerHeartbeatAt?: Date;
  };
} {
  const attentionTotal = Object.values(summary.attention)
    .reduce((total, count) => total + count, 0);

  return {
    generatedAt: summary.generatedAt,
    overall: attentionTotal === 0 ? 'ok' : 'attention_required',
    attention: summary.attention,
    totals: {
      memoryReviews: summary.memoryReviews.total,
      eventProcessingFailures: summary.eventProcessing.failuresTotal,
      actionDecisions: summary.actions.decisions.total,
      actionExecutions: summary.actions.executions.total,
      toolCalls: summary.tools.total,
      jobs: summary.jobs.total,
      workerHeartbeats: summary.workerHeartbeats.total,
      auditEvents: summary.audit.total,
    },
    latest: {
      eventFailureAt: summary.eventProcessing.latestFailureAt,
      workerHeartbeatAt: summary.workerHeartbeats.latestHeartbeatAt,
    },
  };
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(
    `${CLI_ERROR_PREFIX}${projectCliErrorForDisplay(
      message,
      MAX_CLI_ERROR_LENGTH - CLI_ERROR_PREFIX.length,
    )}`,
  );
  process.exitCode = 1;
}

function projectCliErrorForDisplay(
  value: string,
  maxLength = MAX_CLI_ERROR_LENGTH,
): string {
  const withoutControls = [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? ' '
      : character;
  }).join('');
  const singleLine = withoutControls
    .replace(/\s+/gu, ' ')
    .trim();
  const redacted = redactForDisplay(singleLine);
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength - 3)}...`;
}

function redactForDisplay(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]') && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactNullableForDisplay(value: string | null | undefined): string {
  return value ? redactForDisplay(value) : 'N/A';
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function parseIdentityPlatform(value: string): 'qq' {
  if (value === 'qq') {
    return value;
  }

  throw new Error('Invalid identity platform; expected qq');
}

function parseMemorySummaryAction(value: string): MemorySummaryAction {
  switch (value) {
    case 'status':
    case 'enable':
    case 'disable':
      return value;
    default:
      throw new Error('Invalid memory summary action; expected status, enable, or disable');
  }
}

function parseMemorySummaryGroupId(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error('Group ID must be a non-empty trimmed value');
  }
  if (!/^qq-group-[1-9][0-9]{4,11}$/.test(value)) {
    throw new Error('Group ID must use qq-group-<5-12 digit QQ id>');
  }
  return value;
}

function printMemorySummaryPolicy(input: {
  state: 'enabled' | 'disabled';
  changed: boolean;
  canceledJobCount: number;
}): void {
  console.log(redactForDisplay(
    `Group summary policy: state=${input.state}`
    + ` changed=${input.changed} canceled_jobs=${input.canceledJobCount}`
  ));
}

function parseMemoryReviewEventType(value: string | undefined): MemoryReviewAuditEventType | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'memory.conflict.detected':
    case 'memory.consolidation.candidates_detected':
    case 'memory.decay.candidates_detected':
      return value;
    default:
      throw new Error(
        `Invalid memory review event type ${value}; expected memory.conflict.detected, `
        + 'memory.consolidation.candidates_detected, or memory.decay.candidates_detected'
      );
  }
}

function parseMemoryReviewStatus(value: string | undefined): MemoryReviewResolutionStatus {
  const status = value ?? 'all';

  switch (status) {
    case 'all':
    case 'resolved':
    case 'unresolved':
      return status;
    default:
      throw new Error(`Invalid memory review status ${status}; expected all, resolved, or unresolved`);
  }
}

function parseEventProcessingFailureStage(value: string | undefined): EventProcessingFailureStage | undefined {
  if (value === undefined) {
    return undefined;
  }

  for (const stage of EVENT_PROCESSING_FAILURE_STAGES) {
    if (value === stage) {
      return stage;
    }
  }

  throw new Error(
    `Invalid event processing failure stage ${value}; expected ${EVENT_PROCESSING_FAILURE_STAGES.join(', ')}`
  );
}

function parsePrivacyPreferenceType(value: string): PrivacyPreferenceType {
  switch (value) {
    case 'proactive_dm':
    case 'memory_association':
      return value;
    default:
      throw new Error(
        `Invalid privacy preference type ${value}; expected proactive_dm or memory_association`
      );
  }
}

function parseOptionalPrivacyPreferenceType(value: string | undefined): PrivacyPreferenceType | undefined {
  return value === undefined ? undefined : parsePrivacyPreferenceType(value);
}

function parsePrivacyPreferenceState(value: string | undefined): PrivacyPreferenceState | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'opted_in':
    case 'opted_out':
      return value;
    default:
      throw new Error(`Invalid privacy preference state ${value}; expected opted_in or opted_out`);
  }
}

function parseJobStatus(value: string | undefined): JobStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
      return value;
    default:
      throw new Error(`Invalid job status ${value}; expected pending, running, completed, or failed`);
  }
}

function parseJobAttemptStatus(value: string | undefined): JobAttemptStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
      return value;
    default:
      throw new Error(`Invalid job attempt status ${value}; expected running, completed, or failed`);
  }
}

function parseWorkerHeartbeatStatus(value: string | undefined): WorkerHeartbeatStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'idle':
    case 'running':
    case 'stopping':
    case 'error':
      return value;
    default:
      throw new Error(`Invalid worker heartbeat status ${value}; expected idle, running, stopping, or error`);
  }
}

function parseActionDecisionSource(value: string | undefined): ActionDecision['decidedBy'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'attention':
    case 'pi':
    case 'evaluator':
      return value;
    default:
      throw new Error(`Invalid action decision source ${value}; expected attention, pi, or evaluator`);
  }
}

function parseActionRiskLevel(value: string | undefined): ActionDecision['riskLevel'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'prohibited':
      return value;
    default:
      throw new Error(`Invalid action risk level ${value}; expected low, medium, high, or prohibited`);
  }
}

function parseActionType(value: string | undefined): ActionType | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'silent_store':
    case 'silent_summarize_later':
    case 'reply_short':
    case 'reply_full':
    case 'reply_with_tool':
    case 'propose_memory':
    case 'admin_digest':
    case 'schedule_background_task':
    case 'dm_user':
    case 'react_only':
    case 'send_folded_forward':
    case 'ask_clarification':
      return value;
    default:
      throw new Error(
        `Invalid action type ${value}; expected silent_store, silent_summarize_later, reply_short, `
        + 'reply_full, reply_with_tool, propose_memory, admin_digest, schedule_background_task, '
        + 'dm_user, react_only, send_folded_forward, or ask_clarification'
      );
  }
}

function parseActionExecutionStatus(
  value: string | undefined
): ActionExecutionResult['status'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'success':
    case 'downgraded':
    case 'failed':
    case 'rejected':
      return value;
    default:
      throw new Error(
        `Invalid action execution status ${value}; expected success, downgraded, failed, or rejected`
      );
  }
}

function parseToolCallStatus(value: string | undefined): ToolCallResult['status'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'success':
    case 'error':
    case 'timeout':
    case 'rejected':
      return value;
    default:
      throw new Error(`Invalid tool call status ${value}; expected success, error, timeout, or rejected`);
  }
}

function parseAuditCategory(value: string | undefined): AuditEntry['category'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'tool':
    case 'memory':
    case 'social':
    case 'evaluator':
    case 'system':
      return value;
    default:
      throw new Error(`Invalid audit category ${value}; expected tool, memory, social, evaluator, or system`);
  }
}

function parseAuditLevel(value: string | undefined): AuditEntry['level'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'summary':
    case 'redacted_full':
    case 'full':
      return value;
    default:
      throw new Error(`Invalid audit level ${value}; expected summary, redacted_full, or full`);
  }
}

function parseAuditRiskLevel(value: string | undefined): AuditEntry['riskLevel'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'prohibited':
      return value;
    default:
      throw new Error(`Invalid audit risk level ${value}; expected low, medium, high, or prohibited`);
  }
}

function parseConversationType(value: string | undefined): 'private' | 'group' | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'private':
    case 'group':
      return value;
    default:
      throw new Error(`Invalid conversation type ${value}; expected private or group`);
  }
}

function parseMemoryState(value: string | undefined): MemoryRecord['state'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'proposed':
    case 'active':
    case 'rejected':
    case 'superseded':
    case 'disabled':
    case 'deleted':
      return value;
    default:
      throw new Error(
        `Invalid memory state ${value}; expected proposed, active, rejected, superseded, disabled, or deleted`
      );
  }
}

function parseMemoryScope(value: string | undefined): MemoryRecord['scope'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'global':
    case 'user':
    case 'group':
    case 'conversation':
    case 'tool':
    case 'system':
      return value;
    default:
      throw new Error(`Invalid memory scope ${value}; expected global, user, group, conversation, tool, or system`);
  }
}

function parseMemorySensitivity(value: string | undefined): MemoryRecord['sensitivity'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'normal':
    case 'personal':
    case 'sensitive':
    case 'secret':
    case 'prohibited':
      return value;
    default:
      throw new Error(
        `Invalid memory sensitivity ${value}; expected normal, personal, sensitive, secret, or prohibited`
      );
  }
}

function parseMemorySourceType(value: string | undefined): MemorySource['sourceType'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value) {
    case 'raw_event':
    case 'chat_message':
    case 'tool_output':
    case 'worker_extraction':
    case 'user_command':
      return value;
    default:
      throw new Error(
        `Invalid memory source type ${value}; expected raw_event, chat_message, tool_output, worker_extraction, or user_command`
      );
  }
}


function rejectEmptyStringOptionValues(actionCommand: Command): void {
  for (const option of actionCommand.options) {
    if (!option.required) {
      continue;
    }

    const value = actionCommand.getOptionValue(option.attributeName());
    if (value === '') {
      actionCommand.error(`error: option '${option.flags}' argument missing`, {
        code: 'commander.optionMissingArgument',
      });
    }
  }
}

function parseLimit(value: string | undefined, label = 'limit', max = 1000): number {
  const raw = value ?? '100';
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label} ${raw}; expected an integer between 1 and ${max}`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${label} ${raw}; expected an integer between 1 and ${max}`);
  }

  return parsed;
}

program
  .configureOutput({
    outputError: (str, write) => {
      write(`${projectCliErrorForDisplay(str)}\n`);
    },
  })
  .name('lethebot-cli')
  .description('LetheBot governance CLI')
  .version('0.1.0')
  .hook('preAction', (_thisCommand, actionCommand) => {
    rejectEmptyStringOptionValues(actionCommand);
  });

program
  .command('list-memory')
  .description('List memory records')
  .option('--user <userId>', 'Filter by user ID')
  .option('--group <groupId>', 'Filter by group ID')
  .option('--conversation <conversationId>', 'Filter by conversation ID')
  .option('--state <state>', 'Filter by memory lifecycle state')
  .option('--scope <scope>', 'Filter by memory scope')
  .option('--sensitivity <sensitivity>', 'Filter by sensitivity')
  .option('--source-context <sourceContext>', 'Filter by source context')
  .option('--source-type <sourceType>', 'Filter by linked source type')
  .option('--source-id <sourceId>', 'Filter by linked source ID')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    const db = initDatabase({ path: getDbPath() });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const memories = await cli.listMemory({
        userId: options.user,
        groupId: options.group,
        conversationId: options.conversation,
        state: parseMemoryState(options.state),
        scope: parseMemoryScope(options.scope),
        sensitivity: parseMemorySensitivity(options.sensitivity),
        sourceContext: options.sourceContext,
        sourceType: parseMemorySourceType(options.sourceType),
        sourceId: options.sourceId,
        limit: parseLimit(options.limit),
      });

      console.log(`Found ${memories.length} memory records:\n`);
      for (const mem of memories) {
        console.log(`ID: ${redactForDisplay(mem.id)}`);
        console.log(`  Scope: ${redactForDisplay(mem.scope)}`);
        console.log(`  User: ${redactNullableForDisplay(mem.canonicalUserId)}`);
        console.log(`  Group: ${redactNullableForDisplay(mem.groupId)}`);
        console.log(`  Title: ${redactForDisplay(mem.title)}`);
        console.log(`  Content: ${redactForDisplay(mem.content)}`);
        console.log(`  State: ${redactForDisplay(mem.state)}`);
        console.log(`  Visibility: ${redactForDisplay(mem.visibility)}`);
        console.log(`  Confidence: ${mem.confidence}`);
        console.log(`  Created: ${mem.createdAt}`);
        console.log('');
      }
    } catch (error) {
      printError(error);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('show-memory')
  .description('Show one memory record with source, revision, and audit evidence')
  .argument('<memoryId>', 'Memory ID to inspect')
  .action(async (memoryId) => {
    await withGovernanceCli(async (cli) => {
      const result = await cli.showMemory(memoryId);
      if (!result) {
        printCommandResult({ success: false, error: `Memory ${memoryId} not found` });
        return;
      }
      printJson(result);
    });
  });

program
  .command('export-memory')
  .description('Export visible memory as JSON')
  .option('--user <userId>', 'Filter by user ID')
  .option('--group <groupId>', 'Filter by group ID')
  .option('--conversation <conversationId>', 'Filter by conversation ID')
  .option('--state <state>', 'Filter by state; defaults to active')
  .option('--scope <scope>', 'Filter by memory scope')
  .option('--sensitivity <sensitivity>', 'Filter by sensitivity')
  .option('--source-context <sourceContext>', 'Filter by source context')
  .option('--source-type <sourceType>', 'Filter by linked source type')
  .option('--source-id <sourceId>', 'Filter by linked source ID')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const result = await cli.exportMemory({
          userId: options.user,
          groupId: options.group,
          conversationId: options.conversation,
          state: parseMemoryState(options.state),
          scope: parseMemoryScope(options.scope),
          sensitivity: parseMemorySensitivity(options.sensitivity),
          sourceContext: options.sourceContext,
          sourceType: parseMemorySourceType(options.sourceType),
          sourceId: options.sourceId,
          limit: parseLimit(options.limit),
        });
        printJson(result);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('delete-memory')
  .description('Delete a memory record')
  .argument('<memoryId>', 'Memory ID to delete')
  .action((memoryId: string) => {
    const db = initDatabase({ path: getDbPath() });
    const memoryRepo = new MemoryRepository(db);
    const governance = new GovernanceService(db, memoryRepo);

    try {
      const result = governance.forgetMemoryAsLocalAdmin(memoryId);
      const displayId = formatGovernanceMemoryIdForDisplay(memoryId);
      if (result.outcome === 'forgotten') {
        console.log(`✅ Memory ${displayId} deleted`);
      } else {
        console.error(`❌ Memory ${displayId} not found`);
        process.exitCode = 1;
      }
    } catch (error) {
      printError(error);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('memory-summary')
  .description('Inspect or change the exact group summary policy')
  .argument(
    '<action>',
    'Summary policy action (status, enable, or disable)',
    parseMemorySummaryAction,
  )
  .requiredOption(
    '--group <groupId>',
    'Exact group ID',
    parseMemorySummaryGroupId,
  )
  .action((action: MemorySummaryAction, options: { group: string }) => {
    const db = initDatabase({ path: getDbPath() });
    const governance = new GovernanceService(db);

    try {
      if (action === 'status') {
        const policy = governance.getGroupSummaryPolicyAsLocalAdmin(options.group);
        printMemorySummaryPolicy({
          state: policy?.state ?? 'disabled',
          changed: false,
          canceledJobCount: 0,
        });
        return;
      }

      const result = governance.setGroupSummaryPolicyAsLocalAdmin({
        groupId: options.group,
        enabled: action === 'enable',
      });
      printMemorySummaryPolicy({
        state: result.policy?.state ?? 'disabled',
        changed: result.changed,
        canceledJobCount: result.canceledJobCount,
      });
    } catch (error) {
      printError(error);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('disable-memory')
  .description('Disable a memory record')
  .argument('<memoryId>', 'Memory ID to disable')
  .option('--decay-review-audit <auditId>', 'Memory decay review audit row that references this record')
  .action(async (memoryId, options) => {
    const db = initDatabase({ path: getDbPath() });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.disableMemory(memoryId, {
        decayReviewAuditId: options.decayReviewAudit,
      });
      printCommandResult(result);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('enable-memory')
  .description('Enable a disabled memory record')
  .argument('<memoryId>', 'Memory ID to enable')
  .action(async (memoryId) => {
    const db = initDatabase({ path: getDbPath() });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.enableMemory(memoryId);
      printCommandResult(result);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('approve-memory')
  .description('Approve a proposed memory record')
  .argument('<memoryId>', 'Memory ID to approve')
  .action(async (memoryId) => {
    await withGovernanceCli(async (cli) => {
      printCommandResult(await cli.approveMemory(memoryId));
    });
  });

program
  .command('reject-memory')
  .description('Reject a proposed memory record')
  .argument('<memoryId>', 'Memory ID to reject')
  .action(async (memoryId) => {
    await withGovernanceCli(async (cli) => {
      printCommandResult(await cli.rejectMemory(memoryId));
    });
  });

program
  .command('restore-memory')
  .description('Restore a disabled, deleted, or rejected memory record')
  .argument('<memoryId>', 'Memory ID to restore')
  .action(async (memoryId) => {
    await withGovernanceCli(async (cli) => {
      printCommandResult(await cli.restoreMemory(memoryId));
    });
  });

program
  .command('supersede-memory')
  .description('Mark one memory as superseded by another memory')
  .argument('<oldMemoryId>', 'Memory ID to supersede')
  .argument('<replacementMemoryId>', 'Replacement memory ID')
  .option('--review-audit <auditId>', 'Memory conflict/consolidation audit row that references both records')
  .action(async (oldMemoryId, replacementMemoryId, options) => {
    await withGovernanceCli(async (cli) => {
      printCommandResult(await cli.supersedeMemory(oldMemoryId, replacementMemoryId, {
        reviewAuditId: options.reviewAudit,
      }));
    });
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
    const db = initDatabase({ path: getDbPath() });
    const memoryRepo = new MemoryRepository(db);
    const identityRepo = new IdentityRepository(db);
    const contextBuilder = new ContextBuilder(memoryRepo, identityRepo, db);
    const cli = new GovernanceCLI(memoryRepo, { db, contextBuilder });

    try {
      const explanation = await cli.explainContext({
        turnId: options.turn,
        conversationId: options.conversation,
        conversationType: parseConversationType(options.type),
        groupId: options.group,
        canonicalUserId: options.user,
        messageLimit: parseLimit(options.limit, 'recent message limit', 200),
      });

      console.log(`Context explanation for turn ${redactForDisplay(explanation.turnId)}`);
      console.log(
        `ContextPack: ${redactForDisplay(explanation.contextPackId)} (${redactForDisplay(explanation.traceSource)})`
      );
      console.log(`Conversation: ${redactForDisplay(explanation.conversation.conversationId)}`);
      console.log(`Conversation type: ${redactForDisplay(explanation.conversation.conversationType)}`);
      if (explanation.conversation.groupId) {
        console.log(`Group: ${redactForDisplay(explanation.conversation.groupId)}`);
      }
      console.log(`Selected memories: ${redactForDisplay(explanation.selectedMemoryIds.join(', ') || 'none')}`);
      if (explanation.memorySelections && explanation.memorySelections.length > 0) {
        const selectionSummary = explanation.memorySelections.map((selection) => (
          `${selection.memoryId}:${selection.selectionReason}`
          + `:${selection.querySources.join('+') || 'none'}`
          + `:${selection.scopeAffinity}`
          + `:via=${selection.retrievalMethods.join('+')}`
          + `:rank=${selection.retrievalRank}`
        )).join(', ');
        console.log(`Memory selection evidence: ${redactForDisplay(selectionSummary)}`);
      }
      console.log(`Candidate memories: ${redactForDisplay(explanation.candidateMemoryIds.join(', ') || 'none')}`);
      console.log(`Rejected memories: ${redactForDisplay(JSON.stringify(explanation.rejectedMemories))}`);
      console.log(`Filters: ${redactForDisplay(explanation.filtersApplied.join(', '))}`);
      console.log(`Identity fields: ${redactForDisplay(explanation.injectedIdentityFields.join(', ') || 'none')}`);
      console.log(`Token budget: used ${explanation.tokenBudget.used} / max ${explanation.tokenBudget.max}`);
      console.log(
        'Token breakdown: '
        + `recentMessages=${explanation.tokenBudget.breakdown.recentMessages}, `
        + `memory=${explanation.tokenBudget.breakdown.memory}, `
        + `identity=${explanation.tokenBudget.breakdown.identity}, `
        + `system=${explanation.tokenBudget.breakdown.system}`
      );
      const promptLayers = explanation.tokenBudget.promptLayers ?? [];
      if (promptLayers.length > 0) {
        const promptLayerSummary = promptLayers
          .map((layer) => `${layer.name}@${layer.version}=${layer.tokens}`)
          .join(', ');
        console.log(`Prompt layers: ${redactForDisplay(promptLayerSummary)}`);
      }
      if (explanation.actionDecision) {
        const decision = explanation.actionDecision;
        console.log(
          'Action decision: '
          + `${redactForDisplay(decision.id)} `
          + `decided_by=${redactForDisplay(decision.decidedBy)} `
          + `risk=${redactForDisplay(decision.riskLevel)} `
          + `actions=${redactForDisplay(decision.actionTypes.join(', ') || 'none')}`
        );
        console.log(`Action reasons: ${redactForDisplay(decision.reasons.join(', ') || 'none')}`);
        console.log(`Action suppressors: ${redactForDisplay(decision.suppressors.join(', ') || 'none')}`);
        if (decision.executions.length > 0) {
          const executionSummary = decision.executions
            .map((execution) => {
              const parts = [
                `${execution.id}:${execution.actionType}:${execution.status}`,
                execution.effect ? `effect=${execution.effect}` : undefined,
                execution.executedMessageId ? `message=${execution.executedMessageId}` : undefined,
                execution.executedMemoryId ? `memory=${execution.executedMemoryId}` : undefined,
                execution.executedJobId ? `job=${execution.executedJobId}` : undefined,
                execution.downgradedFrom ? `downgraded_from=${execution.downgradedFrom}` : undefined,
                execution.downgradedReason ? `downgraded_reason=${execution.downgradedReason}` : undefined,
                execution.errorCode ? `error_code=${execution.errorCode}` : undefined,
                execution.errorMessage ? `error=${execution.errorMessage}` : undefined,
              ].filter((part): part is string => Boolean(part));

              return parts.join(' ');
            })
            .join(' | ');
          console.log(`Action executions: ${redactForDisplay(executionSummary)}`);
        }
      }
      if (explanation.toolCalls && explanation.toolCalls.length > 0) {
        const toolCallSummary = explanation.toolCalls
          .map((toolCall) => {
            const parts = [
              `${toolCall.id}:${toolCall.toolName}:${toolCall.status}`,
              `requested_by=${toolCall.requestedBy}`,
              toolCall.executionTimeMs !== undefined ? `duration_ms=${toolCall.executionTimeMs}` : undefined,
              toolCall.errorCode ? `error_code=${toolCall.errorCode}` : undefined,
              toolCall.errorMessage ? `error=${toolCall.errorMessage}` : undefined,
            ].filter((part): part is string => Boolean(part));

            return parts.join(' ');
          })
          .join(' | ');
        console.log(`Tool calls: ${redactForDisplay(toolCallSummary)}`);
      }
      console.log(`Recent messages: ${redactForDisplay(explanation.recentMessageIds.join(', ') || 'none')}`);
    } catch (error) {
      printError(error);
    } finally {
      closeDatabase(db);
    }
  });

program
  .command('list-audit')
  .description('List audit records; details are hidden unless --include-details is set')
  .option('--category <category>', 'Filter by category')
  .option('--level <level>', 'Filter by audit level')
  .option('--event-type <eventType>', 'Filter by event type')
  .option('--event-id <eventId>', 'Filter by event ID')
  .option('--user <userId>', 'Filter by actor user ID')
  .option('--risk <riskLevel>', 'Filter by risk level')
  .option('--include-details', 'Include redacted details payloads')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listAudit({
          category: parseAuditCategory(options.category),
          level: parseAuditLevel(options.level),
          eventType: options.eventType,
          eventId: options.eventId,
          userId: options.user,
          riskLevel: parseAuditRiskLevel(options.risk),
          includeDetails: Boolean(options.includeDetails),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-memory-reviews')
  .description('List conflict, consolidation, and decay memory review audit candidates')
  .option(
    '--event-type <eventType>',
    'Filter by memory.conflict.detected, memory.consolidation.candidates_detected, or memory.decay.candidates_detected'
  )
  .option('--memory <memoryId>', 'Filter candidates referencing a memory ID')
  .option('--status <status>', 'Filter by all, resolved, or unresolved', 'all')
  .option('--include-details', 'Include redacted audit details')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listMemoryReviewCandidates({
          eventType: parseMemoryReviewEventType(options.eventType),
          memoryId: options.memory,
          status: parseMemoryReviewStatus(options.status),
          includeDetails: Boolean(options.includeDetails),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('summarize-memory-reviews')
  .description('Summarize memory review audit candidates by status and event type')
  .option(
    '--event-type <eventType>',
    'Filter by memory.conflict.detected, memory.consolidation.candidates_detected, or memory.decay.candidates_detected'
  )
  .option('--memory <memoryId>', 'Filter candidates referencing a memory ID')
  .option('--status <status>', 'Filter by all, resolved, or unresolved', 'all')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const summary = await cli.summarizeMemoryReviews({
          eventType: parseMemoryReviewEventType(options.eventType),
          memoryId: options.memory,
          status: parseMemoryReviewStatus(options.status),
        });
        printJson(summary);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('summarize-governance-health')
  .description('Summarize redacted governance health counts for reviews, actions, tools, jobs, workers, and audit')
  .option('--compact', 'Print only overall status, attention counters, totals, and latest timestamps')
  .action(async (options: { compact?: boolean }) => {
    await withGovernanceCli(async (cli) => {
      const summary = await cli.summarizeGovernanceHealth();
      printJson(options.compact ? compactGovernanceHealth(summary) : summary);
    });
  });

program
  .command('list-action-decisions')
  .description('List persisted action decisions')
  .option('--turn <turnId>', 'Filter by turn ID')
  .option('--decided-by <decidedBy>', 'Filter by attention, pi, or evaluator')
  .option('--risk <riskLevel>', 'Filter by risk level')
  .option('--include-actions', 'Include redacted action plans')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listActionDecisions({
          turnId: options.turn,
          decidedBy: parseActionDecisionSource(options.decidedBy),
          riskLevel: parseActionRiskLevel(options.risk),
          includeActions: Boolean(options.includeActions),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-action-executions')
  .description('List persisted action executions')
  .option('--decision <actionDecisionId>', 'Filter by action decision ID')
  .option('--action-type <actionType>', 'Filter by action type')
  .option('--status <status>', 'Filter by execution status')
  .option('--include-audit-entry', 'Include redacted audit entry payload')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listActionExecutions({
          actionDecisionId: options.decision,
          actionType: parseActionType(options.actionType),
          status: parseActionExecutionStatus(options.status),
          includeAuditEntry: Boolean(options.includeAuditEntry),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-tool-calls')
  .description('List persisted tool calls; input/output are hidden unless --include-payload is set')
  .option('--turn <turnId>', 'Filter by turn ID')
  .option('--tool <toolName>', 'Filter by tool name')
  .option('--status <status>', 'Filter by status')
  .option('--include-payload', 'Include redacted input/output payloads')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listToolCalls({
          turnId: options.turn,
          toolName: options.tool,
          status: parseToolCallStatus(options.status),
          includePayload: Boolean(options.includePayload),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-jobs')
  .description('List durable background jobs; payload/result are hidden unless --include-payload is set')
  .option('--status <status>', 'Filter by job status')
  .option('--type <type>', 'Filter by job type')
  .option('--include-payload', 'Include redacted payload/result')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listJobs({
          status: parseJobStatus(options.status),
          type: options.type,
          includePayload: Boolean(options.includePayload),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-job-attempts')
  .description('List durable background job attempts')
  .option('--job <jobId>', 'Filter by job ID')
  .option('--worker <workerId>', 'Filter by worker ID')
  .option('--status <status>', 'Filter by attempt status')
  .option('--include-result', 'Include redacted attempt result payload')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listJobAttempts({
          jobId: options.job,
          workerId: options.worker,
          status: parseJobAttemptStatus(options.status),
          includeResult: Boolean(options.includeResult),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-worker-heartbeats')
  .description('List durable worker heartbeat rows')
  .option('--worker <workerId>', 'Filter by worker ID')
  .option('--type <workerType>', 'Filter by worker type')
  .option('--status <status>', 'Filter by heartbeat status')
  .option('--include-details', 'Include redacted heartbeat details')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listWorkerHeartbeats({
          workerId: options.worker,
          workerType: options.type,
          status: parseWorkerHeartbeatStatus(options.status),
          includeDetails: Boolean(options.includeDetails),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-event-failures')
  .description('List redacted durable event-processing failure records')
  .option('--stage <stage>', 'Filter by failure stage')
  .option('--raw-event <rawEventId>', 'Filter by internal raw event ID')
  .option('--turn <turnId>', 'Filter by agent turn ID')
  .option('--include-details', 'Include hashed diagnostic details')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listEventProcessingFailures({
          stage: parseEventProcessingFailureStage(options.stage),
          rawEventId: options.rawEvent,
          turnId: options.turn,
          includeDetails: Boolean(options.includeDetails),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('list-privacy-preferences')
  .description('List proactive-DM and memory-association privacy preferences')
  .option('--user <canonicalUserId>', 'Filter by canonical user ID')
  .option('--type <preferenceType>', 'Filter by proactive_dm or memory_association')
  .option('--state <state>', 'Filter by opted_in or opted_out')
  .option('--limit <limit>', 'Maximum records to return', '100')
  .action(async (options) => {
    await withGovernanceCli(async (cli) => {
      try {
        const rows = await cli.listPrivacyPreferences({
          canonicalUserId: options.user,
          preferenceType: parseOptionalPrivacyPreferenceType(options.type),
          state: parsePrivacyPreferenceState(options.state),
          limit: parseLimit(options.limit),
        });
        printJson(rows);
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('set-privacy-opt-out')
  .description('Set a user opt-out for proactive_dm or memory_association')
  .argument('<canonicalUserId>', 'Canonical user ID')
  .argument('<preferenceType>', 'proactive_dm or memory_association')
  .option('--reason <reason>', 'Reason for the governance action')
  .action(async (canonicalUserId, preferenceType, options) => {
    await withGovernanceCli(async (cli) => {
      try {
        printCommandResult(await cli.setPrivacyOptOut({
          canonicalUserId,
          preferenceType: parsePrivacyPreferenceType(preferenceType),
          reason: options.reason,
        }));
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('clear-privacy-opt-out')
  .description('Clear a user opt-out for proactive_dm or memory_association')
  .argument('<canonicalUserId>', 'Canonical user ID')
  .argument('<preferenceType>', 'proactive_dm or memory_association')
  .option('--reason <reason>', 'Reason for the governance action')
  .action(async (canonicalUserId, preferenceType, options) => {
    await withGovernanceCli(async (cli) => {
      try {
        printCommandResult(await cli.clearPrivacyOptOut({
          canonicalUserId,
          preferenceType: parsePrivacyPreferenceType(preferenceType),
          reason: options.reason,
        }));
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('unlink-platform-account')
  .description('Disable an active platform account mapping')
  .argument('<platform>', 'Platform name (qq)')
  .argument('<platformAccountId>', 'Platform account ID to unlink')
  .action(async (platform, platformAccountId) => {
    await withGovernanceCli(async (cli) => {
      try {
        printCommandResult(await cli.unlinkPlatformAccount({
          platform: parseIdentityPlatform(platform),
          platformAccountId,
        }));
      } catch (error) {
        printError(error);
      }
    });
  });

program
  .command('redact-display-profile')
  .description('Redact display profile and nickname history for a user')
  .argument('<canonicalUserId>', 'Canonical user ID')
  .option('--group <groupId>', 'Only redact the group-scoped display profile/history')
  .action(async (canonicalUserId, options) => {
    const db = initDatabase({ path: getDbPath() });
    const memoryRepo = new MemoryRepository(db);
    const cli = new GovernanceCLI(memoryRepo, { db });

    try {
      const result = await cli.redactDisplayProfile({
        canonicalUserId,
        groupId: options.group,
      });

      printCommandResult(result);
    } finally {
      closeDatabase(db);
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  printError(error);
}
