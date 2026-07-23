import type { ActionPlan } from '../types/action.js';
import type { SocialEvaluationResult } from '../types/evaluator.js';

export interface AppliedSocialEvaluation {
  actions: ActionPlan[];
  suppressors: string[];
}

export function applyPassingSocialEvaluation(
  actions: ActionPlan[],
  evaluation: SocialEvaluationResult,
): AppliedSocialEvaluation {
  if (evaluation.decision === 'downgrade') {
    const downgradeAction = evaluation.downgradeAction;
    if (!downgradeAction) {
      throw new Error('Social evaluator downgrade requires a downgrade action');
    }
    if (!actions.some((action) => action.type === downgradeAction.from)) {
      throw new Error('Social evaluator downgrade does not match the proposed action');
    }

    return {
      actions: actions.map((action) => {
        if (action.type !== downgradeAction.from) {
          return action;
        }
        return {
          ...action,
          type: downgradeAction.to,
          reason: downgradeAction.reason,
          constraints: {
            ...action.constraints,
            cooldownSeconds: maxOptionalNumber(
              action.constraints.cooldownSeconds,
              evaluation.cooldownSeconds,
            ),
          },
        };
      }),
      suppressors: [
        `evaluator_downgrade:${downgradeAction.from}->${downgradeAction.to}`,
      ],
    };
  }

  return {
    actions: evaluation.modifiedAction
      ? [anchorModifiedAction(actions[0], evaluation.modifiedAction)]
      : actions,
    suppressors: [],
  };
}

function anchorModifiedAction(
  baseAction: ActionPlan | undefined,
  modifiedAction: ActionPlan,
): ActionPlan {
  if (!baseAction) {
    return modifiedAction;
  }

  return {
    ...modifiedAction,
    target: baseAction.target,
    constraints: anchorModifiedActionConstraints(baseAction.constraints, modifiedAction.constraints),
  };
}

function anchorModifiedActionConstraints(
  baseConstraints: ActionPlan['constraints'],
  modifiedConstraints: ActionPlan['constraints'],
): ActionPlan['constraints'] {
  return {
    ...modifiedConstraints,
    evaluatorRequired: baseConstraints.evaluatorRequired === true || modifiedConstraints.evaluatorRequired === true,
    proactive: baseConstraints.proactive === true || modifiedConstraints.proactive === true,
    cooldownKey: baseConstraints.cooldownKey ?? modifiedConstraints.cooldownKey,
    cooldownSeconds: maxOptionalNumber(baseConstraints.cooldownSeconds, modifiedConstraints.cooldownSeconds),
    maxResponseTokens: minOptionalNumber(baseConstraints.maxResponseTokens, modifiedConstraints.maxResponseTokens),
    redactionLevel: strictestRedactionLevel(baseConstraints.redactionLevel, modifiedConstraints.redactionLevel),
    capabilities: mergeCapabilities(baseConstraints.capabilities, modifiedConstraints.capabilities),
  };
}

function maxOptionalNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function minOptionalNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function strictestRedactionLevel(
  left: ActionPlan['constraints']['redactionLevel'] | undefined,
  right: ActionPlan['constraints']['redactionLevel'] | undefined,
): ActionPlan['constraints']['redactionLevel'] | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const order: Record<NonNullable<ActionPlan['constraints']['redactionLevel']>, number> = {
    none: 0,
    light: 1,
    strict: 2,
  };
  return order[left] >= order[right] ? left : right;
}

function mergeCapabilities(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const capabilities = [...(left ?? []), ...(right ?? [])];
  return capabilities.length > 0 ? [...new Set(capabilities)] : undefined;
}
