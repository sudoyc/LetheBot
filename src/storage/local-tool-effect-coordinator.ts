import type Database from 'better-sqlite3';
import type { AuditEntry } from '../types/audit.js';
import {
  applyPreparedLocalToolEffect,
  type PreparedLocalToolEffect,
} from '../tools/prepared-local-effect.js';
import type { AuditRepository } from './audit-repository.js';
import type {
  ToolCallRecordInput,
  ToolCallRepository,
} from './tool-call-repository.js';

export interface LocalToolTerminalEvidence {
  toolCall: ToolCallRecordInput;
  audit: Omit<AuditEntry, 'id'>;
}

export class LocalToolEffectCoordinator {
  constructor(
    private readonly db: Database.Database,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly auditRepository: AuditRepository,
  ) {}

  commitEffectAndTerminal(
    effect: PreparedLocalToolEffect,
    evidence: LocalToolTerminalEvidence,
  ): void {
    this.db.transaction(() => {
      applyPreparedLocalToolEffect(effect);
      this.toolCallRepository.createSync(evidence.toolCall);
      this.auditRepository.createSync(evidence.audit);
    }).immediate();
  }

  commitTerminalPair(evidence: LocalToolTerminalEvidence): void {
    this.db.transaction(() => {
      this.toolCallRepository.createSync(evidence.toolCall);
      this.auditRepository.createSync(evidence.audit);
    }).immediate();
  }
}
