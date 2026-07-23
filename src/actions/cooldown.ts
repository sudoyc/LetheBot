/**
 * Stateful social action cooldowns.
 *
 * Cooldown never blocks raw ingestion or memory candidates; it only downgrades
 * outward actions into a recorded silent action.
 */

import type { ActionPlan, ActionType } from '../types/action.js';

export interface CooldownResult {
  actions: ActionPlan[];
  suppressors: string[];
}

interface CooldownEntry {
  expiresAt: number;
  actionType: ActionType;
}

export class ActionCooldownManager {
  private readonly entries = new Map<string, CooldownEntry>();

  apply(actions: ActionPlan[], now: Date = new Date()): CooldownResult {
    const suppressors: string[] = [];
    const nowMs = now.getTime();

    const nextActions = actions.map((action) => {
      if (!this.isCooldownEligible(action)) {
        return action;
      }

      const cooldownKey = action.constraints.cooldownKey;
      const cooldownSeconds = action.constraints.cooldownSeconds ?? 0;
      if (!cooldownKey || cooldownSeconds <= 0) {
        return action;
      }

      const existing = this.entries.get(cooldownKey);
      if (existing && existing.expiresAt > nowMs) {
        suppressors.push(`cooldown:${cooldownKey}`);
        return this.toSilentStore(action, existing);
      }

      this.entries.set(cooldownKey, {
        expiresAt: nowMs + cooldownSeconds * 1000,
        actionType: action.type,
      });
      return action;
    });

    return {
      actions: nextActions,
      suppressors,
    };
  }

  clear(): void {
    this.entries.clear();
  }

  private isCooldownEligible(action: ActionPlan): boolean {
    return (
      action.type === 'reply_short' ||
      action.type === 'reply_full' ||
      action.type === 'reply_with_tool' ||
      action.type === 'dm_user' ||
      action.type === 'react_only' ||
      action.type === 'send_folded_forward'
    );
  }

  private toSilentStore(action: ActionPlan, existing: CooldownEntry): ActionPlan {
    return {
      type: 'silent_store',
      priority: action.priority,
      target: action.target,
      constraints: {
        ...action.constraints,
        cooldownKey: action.constraints.cooldownKey,
      },
      reason: `Downgraded from ${action.type}; cooldown active for ${existing.actionType}`,
    };
  }
}
